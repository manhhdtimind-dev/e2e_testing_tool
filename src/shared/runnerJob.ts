import type { AuthCheck } from "./types";

export interface RunnerJob {
  kind: "script" | "authcheck";
  runDir: string;
  compiledPath: string | null;
  input: Record<string, string | number | boolean>;
  secretValues: string[];
  baseUrl: string;
  allowedDomains: string[];
  authCheck: AuthCheck;
  storageStatePath: string | null;
  browser: "chrome" | "chromium" | "msedge";
  headless: boolean;
  timeoutMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  traceOnSuccess: boolean;
}

export type RunnerMessage =
  | { type: "step"; step: import("./types").StepLog }
  | { type: "result"; result: import("./types").RunnerResult };
