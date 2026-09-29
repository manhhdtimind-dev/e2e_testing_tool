import type { ExecutionErrorCode } from "../shared/types";

export interface ErrorLike {
  name?: string;
  message?: string;
}

export const DOMAIN_BLOCKED_MARKER = "E2E_DOMAIN_BLOCKED";
export const AUTH_REQUIRED_MARKER = "E2E_AUTH_REQUIRED";
export const RUN_TIMEOUT_MARKER = "E2E_RUN_TIMEOUT";

const LOCATOR_PATTERNS = [
  /strict mode violation/i,
  /waiting for (get_by|getBy|locator|selector|frameLocator)/i,
  /locator\.[a-zA-Z]+: Timeout/i,
  /resolved to 0 elements/i,
  /element\(s\) not found/i,
  /No node found/i,
  /Unknown engine/i,
  /Unexpected token .* while parsing selector/i,
  /expect\(locator\)/i,
];

const ACTION_PATTERNS = [
  /element is not (visible|enabled|editable|attached|stable)/i,
  /element is outside of the viewport/i,
  /intercepts pointer events/i,
  /not an <input>, <textarea>, <select>/i,
  /Element is not an <select> element/i,
  /did not find some options/i,
];

export function classifyError(err: ErrorLike): ExecutionErrorCode {
  const message = err.message ?? "";
  if (message.includes(AUTH_REQUIRED_MARKER)) return "AUTH_REQUIRED";
  if (message.includes(DOMAIN_BLOCKED_MARKER) || /net::ERR_BLOCKED_BY_CLIENT/i.test(message)) return "DOMAIN_BLOCKED";
  if (message.includes(RUN_TIMEOUT_MARKER)) return "TIMEOUT";
  if (LOCATOR_PATTERNS.some((re) => re.test(message))) return "LOCATOR";
  if (ACTION_PATTERNS.some((re) => re.test(message))) return "ACTION";
  if (err.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(message)) return "TIMEOUT";
  return "EXCEPTION";
}

/** Locator/action failures indicate the script itself no longer matches the UI. */
export function marksVersionBroken(code: ExecutionErrorCode | null): boolean {
  return code === "LOCATOR" || code === "ACTION";
}
