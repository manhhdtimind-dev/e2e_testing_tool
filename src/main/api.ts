import { BrowserWindow, dialog, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { AgentProvider, InputValues, ParsedTestCase, ProjectTarget, ReviewResult, Settings } from "../shared/types";
import type { AppContext } from "./context";
import { fromArtifactRef, paths } from "./paths";
import { AppError } from "./util";
import { updateSettings } from "./services/settings";
import { secretKeys } from "./services/secrets";
import { confirmImport, deleteImpact, deleteProject, deleteTestCase, listProjects, previewImport, saveTestCase, type TestCaseInput } from "./services/testCases";
import { writeSampleCsv, writeSampleXlsx } from "./services/sampleTemplate";
import {
  deleteProfile,
  detectLocalProfiles,
  environmentSecretStatus,
  getEnvironment,
  getProfile,
  listEnvironments,
  listProfiles,
  saveEnvironment,
  saveProfile,
  setEnvironmentSecret,
  type EnvironmentInput,
  type ProfileInput,
} from "./services/environments";
import { beginRunnerLogin, cancelRunnerLogin, clearRunnerAuth, finishRunnerLogin } from "./services/runnerAuth";
import {
  approveCandidate,
  markCandidateReviewed,
  rejectCandidate,
  retireVersion,
  reviewTestRun,
  runnerAuthStatus,
  startTestRun,
  startTrial,
  clearTrials,
} from "./services/execution";
import {
  exportCandidateSource,
  exportRunEvidence,
  exportVersionSource,
  listAttemptsForHistory,
  listTrialsForHistory,
  queryTestRuns,
  readArtifactText,
  type HistoryFilter,
} from "./services/history";
import { cancelTraining, isScriptTraining, saveManualCandidate, startTraining, type StartTrainingRequest } from "./training/orchestrator";
import { runPreflight } from "./training/preflight";
import { getIntegrationStatus, runIntegrationCheck } from "./training/integrationCheck";
export function createApi(ctx: AppContext, win: () => BrowserWindow | null) {
  const saveDialog = async (defaultPath: string, filters: Electron.FileFilter[]) => {
    const w = win();
    const res = w ? await dialog.showSaveDialog(w, { defaultPath, filters }) : await dialog.showSaveDialog({ defaultPath, filters });
    return res.canceled || !res.filePath ? null : res.filePath;
  };

  return {
    // ---------- settings ----------
    getSettings: (): Settings => ctx.settings(),
    updateSettings: (patch: Partial<Settings>) => updateSettings(ctx.repo, ctx.secrets, patch),
    setApiKey: (provider: AgentProvider, key: string) => {
      const k = provider === "codex" ? secretKeys.openaiKey : secretKeys.cursorKey;
      if (key.trim()) ctx.secrets.set(k, key.trim());
      else ctx.secrets.delete(k);
      ctx.repo.audit("settings.api_key", "agent", provider, { cleared: !key.trim() });
      return ctx.settings();
    },
    getIntegrationStatus: () => getIntegrationStatus(ctx),
    runIntegrationCheck: (agent: AgentProvider, profileId: string, envId: string) => runIntegrationCheck(ctx, agent, profileId, envId),

    // ---------- test cases ----------
    listTestCases: () => {
      const projects = new Map(ctx.repo.projects.where("1=1").map((p) => [p.project_id, p.name]));
      const cases = ctx.repo.testCases.where("1=1 ORDER BY test_id");
      return cases
        .map((tc) => {
          const script = ctx.repo.scripts.where("test_id = ?", tc.test_id)[0];
          const versions = script ? ctx.repo.versions.where("script_id = ?", script.script_id) : [];
          return {
            ...tc,
            project_name: (tc.project_id && projects.get(tc.project_id)) || "",
            script_id: script?.script_id ?? null,
            version_count: versions.length,
            approved_count: versions.filter((v) => v.status === "APPROVED").length,
          };
        })
        .sort((a, b) => a.project_name.localeCompare(b.project_name, "vi") || a.group_name.localeCompare(b.group_name, "vi") || a.test_id.localeCompare(b.test_id, "vi", { numeric: true }));
    },
    listProjects: () => listProjects(ctx),
    deleteProject: (projectId: string) => {
      deleteProject(ctx, projectId);
      return true;
    },
    getTestCase: (testId: string) => ctx.repo.testCases.get(testId) ?? null,
    pickAndPreviewImport: async () => {
      const w = win();
      const opts: Electron.OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "Test cases", extensions: ["xlsx", "csv", "yaml", "yml"] }] };
      const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      return previewImport(res.filePaths[0]);
    },
    openSampleTemplate: async () => {
      const dir = join(paths().data, "templates");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "test-cases-mau.xlsx");
      try {
        await writeSampleXlsx(file);
      } catch (e) {
        // Excel keeps the file locked while it is open; reopening the existing copy is fine.
        if (!existsSync(file)) throw e;
      }
      const err = await shell.openPath(file);
      if (err) throw new AppError(`Không mở được file mẫu (${file}): ${err}`);
      return file;
    },
    saveSampleTemplate: async () => {
      const file = await saveDialog("test-cases-mau.xlsx", [
        { name: "Excel", extensions: ["xlsx"] },
        { name: "CSV", extensions: ["csv"] },
      ]);
      if (!file) return null;
      if (extname(file).toLowerCase() === ".csv") await writeSampleCsv(file);
      else await writeSampleXlsx(file);
      shell.showItemInFolder(file);
      return file;
    },
    confirmImport: (fileName: string, project: ProjectTarget, cases: ParsedTestCase[]) => confirmImport(ctx, fileName, project, cases),
    saveTestCase: (input: TestCaseInput) => saveTestCase(ctx, input),
    testCaseDeleteImpact: (testId: string) => deleteImpact(ctx, testId),
    deleteTestCase: (testId: string) => deleteTestCase(ctx, testId, isScriptTraining),

    // ---------- environments & profiles ----------
    listEnvironments: () =>
      listEnvironments(ctx).map((e) => ({ ...e, runner_auth_ready: runnerAuthStatus(ctx, e), secret_status: environmentSecretStatus(ctx, e.environment_id) })),
    saveEnvironment: (input: EnvironmentInput) => saveEnvironment(ctx, input),
    setEnvironmentSecret: (envId: string, field: string, value: string) => setEnvironmentSecret(ctx, envId, field, value),
    beginRunnerLogin: (envId: string) => beginRunnerLogin(ctx, envId),
    finishRunnerLogin: (sessionId: string) => finishRunnerLogin(ctx, sessionId),
    cancelRunnerLogin: (sessionId: string) => cancelRunnerLogin(ctx, sessionId),
    clearRunnerAuth: (envId: string) => clearRunnerAuth(ctx, envId),
    listProfiles: () => listProfiles(ctx),
    saveProfile: (input: ProfileInput) => saveProfile(ctx, input),
    deleteProfile: (id: string) => deleteProfile(ctx, id),
    detectProfiles: () => detectLocalProfiles(),
    preflight: async (profileId: string, envId: string) => {
      const profile = getProfile(ctx, profileId);
      const env = getEnvironment(ctx, envId);
      const res = await runPreflight(profile, env, ctx.secrets.get(secretKeys.profileToken(profileId)));
      ctx.repo.audit("preflight.manual", "browser_profile", profileId, { environment_id: envId, status: res.status });
      return res;
    },

    // ---------- training ----------
    getScriptState: (testId: string) => {
      const script = ctx.repo.scripts.where("test_id = ?", testId)[0] ?? null;
      if (!script) return { script: null, threads: [], attempts: [], candidates: [], trials: [], versions: [] };
      const candidates = ctx.repo.candidates.where("script_id = ? ORDER BY revision_no DESC", script.script_id);
      return {
        script,
        threads: ctx.repo.threads.where("script_id = ? ORDER BY created_at", script.script_id),
        attempts: ctx.repo.attempts.where("script_id = ? ORDER BY created_at DESC", script.script_id),
        candidates,
        trials: ctx.repo.db
          .all<{ trial_id: string }>(
            "SELECT t.trial_id FROM trials t JOIN candidates c ON c.candidate_id = t.candidate_id WHERE c.script_id = ? ORDER BY t.created_at DESC",
            script.script_id,
          )
          .map((r) => ctx.repo.trials.get(r.trial_id)!),
        versions: ctx.repo.versions.where("script_id = ? ORDER BY version_no DESC", script.script_id),
      };
    },
    startTraining: (req: StartTrainingRequest) => startTraining(ctx, req),
    cancelTraining: (attemptId: string) => cancelTraining(ctx, attemptId),
    markCandidateReviewed: (candidateId: string) => markCandidateReviewed(ctx, candidateId),
    rejectCandidate: (candidateId: string) => rejectCandidate(ctx, candidateId),
    saveManualCandidate: (candidateId: string, source: string, envId: string) => saveManualCandidate(ctx, candidateId, source, envId || undefined),
    startTrial: (candidateId: string, envId: string, input: InputValues) => startTrial(ctx, candidateId, envId, input),
    clearTrials: (candidateId: string) => clearTrials(ctx, candidateId),
    approveCandidate: (candidateId: string, envId: string) => approveCandidate(ctx, candidateId, envId),

    // ---------- testing ----------
    startTestRun: (testId: string, versionNo: number, envId: string, input: InputValues) => startTestRun(ctx, testId, versionNo, envId, input),
    reviewTestRun: (runId: string, result: Exclude<ReviewResult, "PENDING">, note: string) => reviewTestRun(ctx, runId, result, note),
    listTestRuns: (testId: string) => ctx.repo.testRuns.where("test_id = ? ORDER BY created_at DESC LIMIT 200", testId),
    getTestRun: (runId: string) => ctx.repo.testRuns.get(runId) ?? null,
    retireVersion: (scriptId: string, versionNo: number) => retireVersion(ctx, scriptId, versionNo),

    // ---------- history & artifacts ----------
    queryHistory: (f: HistoryFilter) => queryTestRuns(ctx, f),
    listTrialHistory: (testId?: string) => listTrialsForHistory(ctx, testId),
    listAttemptHistory: (testId?: string) => listAttemptsForHistory(ctx, testId),
    listAudit: (limit?: number) => ctx.repo.listAudit(limit),
    readArtifact: (ref: string) => readArtifactText(ref),
    artifactExists: (ref: string) => {
      try {
        return existsSync(fromArtifactRef(ref));
      } catch {
        return false;
      }
    },
    revealArtifact: (ref: string) => {
      const abs = fromArtifactRef(ref);
      if (!existsSync(abs)) throw new AppError("Artifact không còn (có thể đã hết hạn lưu trữ)");
      shell.showItemInFolder(abs);
    },
    exportVersion: async (scriptId: string, versionNo: number, testId: string) => {
      const dest = await saveDialog(`${testId}_v${versionNo}.ts`, [{ name: "TypeScript", extensions: ["ts"] }]);
      if (dest) exportVersionSource(ctx, scriptId, versionNo, dest);
      return dest;
    },
    exportCandidate: async (candidateId: string, name: string) => {
      const dest = await saveDialog(`${name}.ts`, [{ name: "TypeScript", extensions: ["ts"] }]);
      if (dest) exportCandidateSource(ctx, candidateId, dest);
      return dest;
    },
    exportEvidence: async (runId: string) => {
      const dest = await saveDialog(`${runId}_evidence.zip`, [{ name: "Zip", extensions: ["zip"] }]);
      if (dest) exportRunEvidence(ctx, runId, dest);
      return dest;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
