import { describe, expect, it } from "vitest";
import { pickReferences, referenceFile, referenceFileName, referenceIndex, summarizeScript, type ReferenceScript } from "../src/core/projectReferences";
import { verifyDraft, type VerifyRun } from "../src/main/training/draftVerify";
import { bootstrapPrompt, initialPrompt, projectReferencesBlock, revisePrompt, verifyFailPrompt } from "../src/main/training/prompt";
import type { Environment, TestCase } from "../src/shared/types";

const CREATE = `import { expect, type Page } from "@playwright/test";

export async function run(page: Page, input: { campaign_name: string }): Promise<void> {
  // Step 1: Mở trang Campaign
  await page.goto("/campaigns");
  await page.getByRole("button", { name: "Create Campaign" }).click();
  await page.getByLabel("Campaign Name").fill(input.campaign_name);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\\/campaigns$/);
}
`;

const ref = (over: Partial<ReferenceScript>): ReferenceScript => ({
  test_id: "TC_X",
  title: "",
  group_name: "",
  steps: [],
  version_no: 1,
  approved_at: "2026-09-01T00:00:00Z",
  source: CREATE,
  ...over,
});

describe("project references", () => {
  it("ranks by similarity of title and steps, gives the same group a bonus and respects the limits", () => {
    const refs = [
      ref({ test_id: "TC_LOGIN", title: "Đăng nhập", steps: ["Mở trang login", "Nhập mật khẩu"] }),
      ref({ test_id: "TC_CREATE", title: "Tạo campaign mới", steps: ["Mở trang Campaign", "Click Create Campaign", "Nhập Campaign Name = {{campaign_name}}"] }),
      ref({ test_id: "TC_SEARCH", title: "Tìm campaign", group_name: "Campaign", steps: ["Mở trang Campaign", "Nhập từ khoá tìm kiếm"] }),
    ];
    const target = { title: "Sửa campaign", group_name: "Campaign", steps: ["Mở trang Campaign", "Click Create Campaign", "Sửa Campaign Name"] };
    expect(pickReferences(target, refs, { max: 5, maxChars: 100_000 }).map((r) => r.test_id)).toEqual(["TC_CREATE", "TC_SEARCH", "TC_LOGIN"]);
    expect(pickReferences(target, refs, { max: 1, maxChars: 100_000 }).map((r) => r.test_id)).toEqual(["TC_CREATE"]);
    expect(pickReferences(target, refs, { max: 5, maxChars: CREATE.length * 2 })).toHaveLength(2);
  });

  it("summarizes pages and locators from the script AST", () => {
    const s = summarizeScript(CREATE);
    expect(s.urls).toEqual(["/campaigns", "/\\/campaigns$/"]);
    expect(s.locators).toEqual(['getByRole("button", { name: "Create Campaign" })', 'getByLabel("Campaign Name")', 'getByRole("button", { name: "Save" })']);
  });

  it("writes an index and read-only reference files with safe names", () => {
    const r = ref({ test_id: "TC/01 a", title: "Tạo campaign", steps: ["Mở trang Campaign"], version_no: 3 });
    expect(referenceFileName(r.test_id)).toBe("TC_01_a.ts");
    const index = referenceIndex([r]);
    expect(index).toContain("## TC/01 a — Tạo campaign (v3, file `TC_01_a.ts`)");
    expect(index).toContain("1. Mở trang Campaign");
    expect(index).toContain("Pages: `/campaigns`");
    expect(index).toContain('- `getByLabel("Campaign Name")`');
    expect(referenceFile(r).startsWith("// Reference only (read-only): TC/01 a")).toBe(true);
  });
});

describe("prompts with project references", () => {
  const tc = { test_id: "TC_EDIT", title: "Sửa campaign", steps: ["Mở trang Campaign", "Chụp màn hình"], expected_result: "", input_schema: { fields: [] } } as unknown as TestCase;
  const env = { base_url: "http://localhost:4600", allowed_domains: ["localhost"] } as unknown as Environment;

  it("adds the reference block to the first prompt; draft mode overrides exploring every step", () => {
    const plain = projectReferencesBlock({ testIds: ["TC_CREATE"], draft: false });
    expect(plain).toContain("reference/README.md");
    expect(plain).not.toContain("Draft first");
    const draft = projectReferencesBlock({ testIds: ["TC_CREATE", "TC_SEARCH"], draft: true });
    expect(draft).toContain("2 approved script(s) of other test cases in this project (TC_CREATE, TC_SEARCH)");
    expect(draft).toContain("without any browser action");
    const prompt = initialPrompt(tc, env, {}, 80, "", draft);
    expect(prompt.indexOf("Draft first")).toBeGreaterThan(prompt.indexOf("## How to work"));
    expect(initialPrompt(tc, env, {}, 80, "")).not.toContain("reference/");
  });

  it("tells the agent which revision it edits when the user picked an older one than the newest", () => {
    const base = { userPrompt: "sửa step 4", sample: {}, tc, lastRun: null, maxActions: 50 };
    expect(revisePrompt({ ...base, revisionNo: 3, latestNo: 3 })).toContain("candidate revision #3 (the latest saved version)");
    const older = revisePrompt({ ...base, revisionNo: 1, latestNo: 3 });
    expect(older).toContain("candidate revision #1, the revision the user chose to edit (newer revisions up to #3 exist");
    expect(older).not.toContain("latest saved version");
    const boot = bootstrapPrompt({ tc, env, sample: {}, maxActions: 50, revisionNo: 2, latestNo: 4, promptHistory: [], lastRun: null, userPrompt: "", reason: "r" });
    expect(boot).toContain("candidate revision #2, the revision the user chose to edit (newer revisions up to #4 exist");
  });

  it("sends the verification failure with masked input and the step directives", () => {
    const p = verifyFailPrompt({
      tc,
      round: 1,
      maxActions: 80,
      run: { label: "Verification run 1", status: "FAILED", error_code: "LOCATOR", error_message: "locator.click: Timeout", steps: [], input: { password: "***" } },
    });
    expect(p).toContain("(LOCATOR)");
    expect(p).toContain('"password":"***"');
    expect(p).toContain('step 2 ("Chụp màn hình")');
  });
});

describe("draft verification loop", () => {
  const runResult = (ok: boolean, authRequired = false): VerifyRun<string> => ({ ok, authRequired, summary: ok ? "" : "LOCATOR — x", data: "" });

  it("stops at the first passing run", async () => {
    const runs: string[] = [];
    const r = await verifyDraft("v1", {
      maxFixRounds: 2,
      run: async (src) => (runs.push(src), runResult(true)),
      fix: async () => "never",
      aborted: () => false,
      status: () => undefined,
    });
    expect(runs).toEqual(["v1"]);
    expect(r).toMatchObject({ source: "v1", rounds: 1, last: { ok: true } });
  });

  it("lets the agent fix failures up to the limit and returns the last source that was run", async () => {
    const runs: string[] = [];
    let n = 1;
    const r = await verifyDraft("v1", {
      maxFixRounds: 2,
      run: async (src) => (runs.push(src), runResult(false)),
      fix: async () => `v${++n}`,
      aborted: () => false,
      status: () => undefined,
    });
    expect(runs).toEqual(["v1", "v2", "v3"]);
    expect(r).toMatchObject({ source: "v3", rounds: 3, last: { ok: false } });
  });

  it("keeps the last run source when the fix is invalid, unchanged, or the runner needs login", async () => {
    const base = { maxFixRounds: 2, aborted: () => false, status: () => undefined };
    expect((await verifyDraft("v1", { ...base, run: async () => runResult(false), fix: async () => null })).source).toBe("v1");
    expect((await verifyDraft("v1", { ...base, run: async () => runResult(false), fix: async () => "v1" })).rounds).toBe(1);
    let fixes = 0;
    const auth = await verifyDraft("v1", { ...base, run: async () => runResult(false, true), fix: async () => (fixes++, "v2") });
    expect(fixes).toBe(0);
    expect(auth.last.authRequired).toBe(true);
  });
});
