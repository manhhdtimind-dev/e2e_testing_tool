import type { StepLog } from "../shared/types";

const ACTIONS = new Set([
  "goto", "reload", "goBack", "goForward", "waitForURL", "waitForLoadState", "waitForSelector", "waitForResponse",
  "click", "dblclick", "fill", "type", "pressSequentially", "press", "check", "uncheck", "setChecked", "selectOption",
  "hover", "focus", "blur", "clear", "setInputFiles", "dragTo", "dragAndDrop", "tap", "waitFor", "scrollIntoViewIfNeeded",
  "textContent", "innerText", "inputValue", "isVisible", "isChecked", "isEnabled", "count", "getAttribute", "allTextContents",
  "insertText", "down", "up", "selectText", "close",
]);

const FACTORIES = new Set([
  "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle",
  "frameLocator", "first", "last", "nth", "filter", "and", "or", "contentFrame", "owner", "mainFrame", "frame",
]);

const NESTED = new Set(["keyboard", "mouse"]);
const RAW = Symbol("e2e_raw");

export function unwrap<T>(v: T): T {
  return (v && typeof v === "object" && (v as Record<symbol, unknown>)[RAW]) ? ((v as Record<symbol, unknown>)[RAW] as T) : v;
}

export function redact(text: string, secrets: string[]): string {
  let s = text;
  for (const secret of secrets) if (secret && secret.length >= 3) s = s.split(secret).join("***");
  return s;
}

function fmt(arg: unknown, secrets: string[]): string {
  if (typeof arg === "function") return "ƒ";
  let s: string;
  try {
    s = typeof arg === "string" ? JSON.stringify(arg) : (JSON.stringify(unwrap(arg)) ?? String(arg));
  } catch {
    s = String(arg);
  }
  s = redact(s, secrets);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export interface Recorder {
  steps: StepLog[];
  onStep?: (s: StepLog) => void;
  secrets: string[];
  /** Where the next script screenshot is written; any path given by the script is replaced. */
  nextScreenshotPath?: () => string;
  onScreenshot?: (path: string) => void;
}

/**
 * Wraps Playwright page/locator objects so every UI action is recorded as a step.
 * Arguments that are themselves wrapped are unwrapped before reaching Playwright.
 */
export function instrument<T extends object>(target: T, label: string, rec: Recorder): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === RAW) return obj;
      const value = Reflect.get(obj, prop, obj);
      if (typeof prop !== "string") return typeof value === "function" ? value.bind(obj) : value;
      if (NESTED.has(prop) && value && typeof value === "object") return instrument(value, `${label}.${prop}`, rec);
      if (typeof value !== "function") return value;
      if (FACTORIES.has(prop)) {
        return (...args: unknown[]) => {
          const out = value.apply(obj, args.map(unwrap));
          const childLabel = `${label}.${prop}(${args.map((a) => fmt(a, rec.secrets)).join(", ")})`;
          return out && typeof out === "object" && !(out instanceof Promise) ? instrument(out, childLabel, rec) : out;
        };
      }
      const isScreenshot = prop === "screenshot" && !!rec.nextScreenshotPath;
      if (ACTIONS.has(prop) || isScreenshot) {
        return async (...args: unknown[]) => {
          let callArgs = args.map(unwrap);
          let shotPath: string | null = null;
          if (isScreenshot) {
            shotPath = rec.nextScreenshotPath!();
            const opts = callArgs[0] && typeof callArgs[0] === "object" ? (callArgs[0] as Record<string, unknown>) : {};
            callArgs = [{ ...opts, path: shotPath }];
          }
          const step: StepLog = {
            index: rec.steps.length + 1,
            action: prop,
            target: label,
            args: args.map((a) => fmt(a, rec.secrets)),
            started_at: new Date().toISOString(),
            duration_ms: 0,
            ok: true,
          };
          rec.steps.push(step);
          const t0 = Date.now();
          try {
            const out = await value.apply(obj, callArgs);
            if (shotPath) rec.onScreenshot?.(shotPath);
            return out;
          } catch (e) {
            step.ok = false;
            step.error = redact(String((e as Error).message ?? e), rec.secrets).slice(0, 2000);
            throw e;
          } finally {
            step.duration_ms = Date.now() - t0;
            rec.onStep?.(step);
          }
        };
      }
      return value.bind(obj);
    },
  });
}
