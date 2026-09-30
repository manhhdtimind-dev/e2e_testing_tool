import { describe, expect, it } from "vitest";
import { checkApprove, isVersionSelectable, nextVersionNo } from "../src/core/rules";
import { classifyError, marksVersionBroken } from "../src/core/errorClassifier";
import { allowedOriginsArg, isUrlAllowed, normalizeDomains } from "../src/core/domains";
import { maskInput, validateInput } from "../src/core/inputValidation";
import type { CandidateRevision, ScriptVersion, TrialRun } from "../src/shared/types";

const candidate: CandidateRevision = {
  candidate_id: "c1",
  script_id: "s1",
  revision_no: 1,
  source: "x",
  source_hash: "h1",
  action_log_ref: null,
  provider_thread_id: null,
  attempt_id: null,
  origin: "manual",
  status: "DRAFT",
  reviewed_at: "2026-09-29T00:00:00Z",
  created_at: "2026-09-29T00:00:00Z",
};

const trial = (over: Partial<TrialRun>): TrialRun => ({
  trial_id: "t",
  candidate_id: "c1",
  source_hash: "h1",
  environment_id: "e1",
  input_snapshot: {},
  status: "PASSED",
  error_code: null,
  error_message: null,
  evidence_refs: {},
  created_at: "",
  started_at: "",
  finished_at: "2026-09-29T01:00:00Z",
  ...over,
});

describe("approve rules", () => {
  it("does not require a trial or review", () => {
    expect(checkApprove(candidate, [], "e1")).toEqual({ ok: true, trial: undefined });
    expect(checkApprove({ ...candidate, reviewed_at: null }, [trial({ status: "FAILED" })], "e1").ok).toBe(true);
  });

  it("attaches only a PASSED trial of the same candidate, hash and environment", () => {
    expect(checkApprove(candidate, [trial({})], "e1").trial?.trial_id).toBe("t");
    expect(checkApprove(candidate, [trial({ status: "FAILED" })], "e1").trial).toBeUndefined();
    expect(checkApprove(candidate, [trial({ source_hash: "h0" })], "e1").trial).toBeUndefined();
    expect(checkApprove(candidate, [trial({ environment_id: "e2" })], "e1").trial).toBeUndefined();
    expect(checkApprove(candidate, [trial({ candidate_id: "c2" })], "e1").trial).toBeUndefined();
  });

  it("allows accepting a rejected candidate but not accepting twice", () => {
    expect(checkApprove({ ...candidate, status: "REJECTED" }, [], "e1").ok).toBe(true);
    expect(checkApprove({ ...candidate, status: "APPROVED" }, [], "e1").ok).toBe(false);
  });

  it("versions", () => {
    const v = { status: "SUSPECTED_BROKEN", version_no: 2 } as ScriptVersion;
    expect(isVersionSelectable(v)).toBe(false);
    expect(isVersionSelectable({ ...v, status: "APPROVED" })).toBe(true);
    expect(nextVersionNo([v, { ...v, version_no: 1 }])).toBe(3);
    expect(nextVersionNo([])).toBe(1);
  });
});

describe("error classification", () => {
  it("classifies Playwright errors", () => {
    expect(classifyError({ name: "TimeoutError", message: "locator.click: Timeout 5000ms exceeded.\nwaiting for getByRole('button', { name: 'Save' })" })).toBe("LOCATOR");
    expect(classifyError({ message: "strict mode violation: getByText('A') resolved to 2 elements" })).toBe("LOCATOR");
    expect(classifyError({ message: "element is not enabled" })).toBe("ACTION");
    expect(classifyError({ name: "TimeoutError", message: "page.goto: Timeout 30000ms exceeded." })).toBe("TIMEOUT");
    expect(classifyError({ message: "E2E_AUTH_REQUIRED: login page" })).toBe("AUTH_REQUIRED");
    expect(classifyError({ message: "TypeError: x is undefined" })).toBe("EXCEPTION");
    expect(marksVersionBroken("LOCATOR")).toBe(true);
    expect(marksVersionBroken("AUTH_REQUIRED")).toBe(false);
  });
});

describe("domains & input", () => {
  it("checks domains", () => {
    const d = normalizeDomains("http://localhost:4567/app", ["*.example.com", "https://cdn.test/x"]);
    expect(d).toEqual(["localhost", "*.example.com", "cdn.test"]);
    expect(isUrlAllowed("http://localhost:4567/a", d)).toBe(true);
    expect(isUrlAllowed("https://a.example.com/", d)).toBe(true);
    expect(isUrlAllowed("https://evil.com/", d)).toBe(false);
    expect(allowedOriginsArg("http://localhost:4567", [])).toContain("http://localhost:4567");
  });

  it("validates and masks input", () => {
    const schema = {
      fields: [
        { name: "a", type: "number" as const, required: true, secret: false },
        { name: "p", type: "string" as const, required: true, secret: true },
      ],
    };
    expect(validateInput(schema, { a: "x", p: "" })).toEqual(['"a" phải là số', 'Thiếu giá trị cho "p"']);
    expect(validateInput(schema, { a: "1", p: "z", q: "1" })).toEqual(['"q" không thuộc input_schema']);
    expect(maskInput({ a: "1", p: "z" }, new Set(["p"]))).toEqual({ a: "1", p: "***" });
  });
});
