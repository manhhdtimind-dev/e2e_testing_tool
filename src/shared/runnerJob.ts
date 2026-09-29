export interface RunnerJob {
  runDir: string;
  compiledPath: string;
  input: Record<string, string | number | boolean>;
  secretValues: string[];
  baseUrl: string;
  allowedDomains: string[];
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
