import type { Environment, InputValues, StepLog, TestCase, ValidationIssue } from "../../shared/types";
import { fieldTsType, SECRET_MASK } from "../../core/inputValidation";
import { stepDirectives } from "../../core/stepDirectives";

export const CANDIDATE_FILE = "candidate.ts";

export interface RunContext {
  label: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  steps: StepLog[];
  input: InputValues;
}

function inputTypeLiteral(tc: TestCase): string {
  const fields = tc.input_schema.fields.map((f) => `${f.name}: ${fieldTsType(f.type)}`).join("; ");
  return `{ ${fields} }`;
}

function sampleInputBlock(tc: TestCase, sample: InputValues): string {
  const lines = tc.input_schema.fields.map((f) => {
    const v = f.secret
      ? `${SECRET_MASK} (secret — not available during training; still reference input.${f.name} in code)`
      : f.type === "file"
        ? `${JSON.stringify(sample[f.name] ?? "")} (file to upload — see "Files to upload")`
        : JSON.stringify(sample[f.name] ?? "");
    return `- ${f.name} (${f.type}${f.required ? ", required" : ""}): ${v}`;
  });
  return lines.length ? lines.join("\n") : "- (no input fields)";
}

export const FIXTURES_DIR = "fixtures";

export interface UploadFile {
  field: string;
  name: string;
  /** Absolute path of the copy in a folder the Playwright MCP server may read. */
  path: string;
}

/** How to upload the sample files while exploring and in the script. */
export function fileInputsBlock(files: UploadFile[]): string {
  if (!files.length) return "";
  return `## Files to upload
The sample files were copied to a folder the browser tools are allowed to read:
${files.map((f) => `- input.${f.field} = ${JSON.stringify(f.name)} → ${f.path}`).join("\n")}
- While exploring: click the page's upload control first; when the tool reports a file chooser, call browser_file_upload with the absolute path above (paths as listed, not relative ones).
- In the script: \`await <locator of the file input or the element that opens the chooser>.setInputFiles(input.<field>)\` — the runner passes the absolute path of the chosen file in input.<field>. Never write a file name or path literally; to check the uploaded name on the page use \`input.<field>.split(/[\\\\/]/).pop()\`. If the page only opens a chooser, use \`const chooser = page.waitForEvent("filechooser"); await <click>; await (await chooser).setFiles(input.<field>);\`.`;
}

export function testCaseBlock(tc: TestCase, env: Environment, sample: InputValues): string {
  return `## Test case
- test_id: ${tc.test_id}
- title: ${tc.title}
- manual steps:
${tc.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}
- expected result (context only — a human verifies it; do not try to prove it): ${tc.expected_result}

## Environment
- base URL: ${env.base_url}
- allowed domains: ${env.allowed_domains.join(", ")} — never navigate anywhere else.

## Input schema and sample input for THIS training run
${sampleInputBlock(tc, sample)}
Values like {{name}} in the steps refer to input fields.`;
}

export const UNATTENDED_NOTE = `This is an unattended, non-interactive run: nobody can answer questions or approve a plan until the turn has ended. Do not stop to ask for confirmation, and do not follow interactive workflows from personal skills or instruction files (brainstorming, design approval, planning sign-off, etc.). Decide reasonably, apply the change to \`${CANDIDATE_FILE}\`, and explain your choices in the final reply. Use status "blocked" only for the site/step problems described in these instructions.`;

/** Where the script must take screenshots and close the browser, derived from the manual steps. */
export function directivesBlock(tc: TestCase): string {
  const d = stepDirectives(tc.steps);
  const quote = (n: number) => `step ${n} ("${tc.steps[n - 1]}")`;
  const lines: string[] = [];
  if (d.screenshot.length) {
    for (const n of d.screenshot) {
      lines.push(`- ${quote(n)}: call \`await page.screenshot()\` exactly at this point, after the result of the previous steps is visible (wait for it with expect first).`);
    }
    lines.push("- Take screenshots ONLY at these steps — no extra ones.");
  } else {
    lines.push("- No step asks for a screenshot: take one `await page.screenshot()` after the last step so the run has evidence.");
  }
  if (d.close.length) {
    for (const n of d.close) {
      lines.push(`- ${quote(n)}: call \`await page.close()\` at this point; no browser action may follow it in the script.`);
    }
    lines.push("- While exploring with the MCP tools, do NOT close the browser or its tab — it is the user's profile. Only write the close into the script.");
  } else {
    lines.push("- No step asks to close the browser: do not call page.close() / context.close() / browser.close(); the runner decides what happens after the script.");
  }
  lines.push("- If the user's instructions in this prompt say otherwise for a specific screenshot or close, the user's instructions win.");
  return `## Screenshot and close-browser steps (follow exactly)\n${lines.join("\n")}`;
}

export function rulesBlock(tc: TestCase, maxActions: number): string {
  return `## How to work
1. Use ONLY the Playwright MCP tools of server "playwright" (browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_select_option, browser_press_key, browser_file_upload, browser_wait_for, ...). They drive the user's already logged-in Chrome profile. Read page structure from the accessibility snapshot; call browser_take_screenshot only when the snapshot is not enough.
2. Perform the manual steps on the real site with the sample input. One manual step may need several actions. Do not do anything the steps do not ask for. Budget: at most ${maxActions} browser actions.
3. Write (or overwrite) the file \`${CANDIDATE_FILE}\` in the current working directory:
\`\`\`ts
import { expect, type Page } from "@playwright/test";

type Input = ${inputTypeLiteral(tc)};

export async function run(page: Page, input: Input): Promise<void> {
  // Step 1: ...
}
\`\`\`
   Rules for the script:
   - Every test-data value must come from \`input.<field>\`. Never hardcode sample values or secrets.
   - Use relative URLs with page.goto (the runner sets baseURL to the environment base URL).
   - Prefer getByRole / getByLabel / getByTestId / getByText locators taken from the snapshot or from the Playwright code the tools return. Never use mouse coordinates or click positions.
   - Wait on conditions (expect(...).toBeVisible(), page.waitForURL(...)), not fixed timeouts. Never call page.pause() — the runner is unattended.
   - Do not add waitForTimeout or other delays to slow the run down: the runner replays every action at a speed a person can follow by itself.
   - Do not log in inside the script (the runner has its own authenticated session). Only import from "@playwright/test". No fs, process, require, eval or network calls.
   - Add a comment \`// Step N: <manual step>\` before the code of each manual step.
   - The Trial/Testing runner captures nothing and closes nothing by itself: screenshots and closing the browser happen only where the script does them, as listed in "Screenshot and close-browser steps" below. Use \`await page.screenshot()\` (optionally \`{ fullPage: true }\`) and never pass a \`path\` — the runner decides where evidence is stored. Close only with \`await page.close()\`.
4. At the end call browser_take_screenshot once to capture the final state (this is for the training record, not the script).
5. Stop immediately (without guessing) if: a login page or expired session appears → status "auth_required"; a step is ambiguous, impossible, or needs a domain outside the allowed list → status "blocked" with the reason.
6. Finish your reply with ONE line of JSON and nothing after it:
{"status":"done"|"blocked"|"auth_required","reason":"<short reason>","steps_done":[<step numbers completed>]}

${directivesBlock(tc)}`;
}

export function runContextBlock(ctx: RunContext): string {
  const steps = ctx.steps
    .slice(-25)
    .map((s) => `  ${s.index}. ${s.ok ? "ok " : "ERR"} ${s.target}.${s.action}(${s.args.join(", ")})${s.error ? ` → ${s.error.split("\n")[0]}` : ""}`)
    .join("\n");
  return `## ${ctx.label}
- status: ${ctx.status}${ctx.error_code ? ` (${ctx.error_code})` : ""}
- input used: ${JSON.stringify(ctx.input)}
${ctx.error_message ? `- error:\n\`\`\`\n${ctx.error_message.slice(0, 3000)}\n\`\`\`` : ""}
${steps ? `- executed steps (runner log):\n${steps}` : "- no steps were executed"}`;
}

export const REFERENCE_DIR = "reference";

/** Approved scripts of the same project copied into the workspace; in draft mode the app verifies the script itself. */
export function projectReferencesBlock(opts: { testIds: string[]; draft: boolean }): string {
  const base = `## Approved scripts from the same project (\`${REFERENCE_DIR}/\`)
\`${REFERENCE_DIR}/\` in the working directory holds ${opts.testIds.length} approved script(s) of other test cases in this project (${opts.testIds.join(", ")}), written for this site and accepted by a person. Read \`${REFERENCE_DIR}/README.md\` first: it lists their steps, pages and locators.
- Reuse their navigation, locators and waiting patterns wherever the manual steps touch the same pages.
- Do not copy their test data: values still come only from input.<field> of THIS test case. Do not edit files in \`${REFERENCE_DIR}/\` and do not import them.`;
  if (!opts.draft) return base;
  return `${base}

### Draft first — the app verifies (this overrides "How to work" steps 2 and 4)
Right after your turn the app runs \`${CANDIDATE_FILE}\` itself (headless runner, the sample input, an authenticated session) and sends you the exact failure if it does not pass.
- For steps whose pages and elements the references already cover, write the code directly — no browser actions.
- Use the Playwright MCP tools only for steps or pages the references do not cover, or to check an element you are unsure about.
- If the references cover every step, write \`${CANDIDATE_FILE}\` without any browser action and skip the final browser_take_screenshot.`;
}

/** Sent after the app's own run of a draft failed. */
export function verifyFailPrompt(opts: { tc: TestCase; run: RunContext; round: number; maxActions: number }): string {
  return `The app ran \`${CANDIDATE_FILE}\` on the site (verification run ${opts.round}: headless runner, the sample input, authenticated session) and it did not pass.
${UNATTENDED_NOTE}

${runContextBlock(opts.run)}

Find the cause with the Playwright MCP tools (open the page where it failed and read its snapshot; the run may have created data, so do not rely on the page being unchanged), then fix \`${CANDIDATE_FILE}\` in place. Budget ${opts.maxActions} browser actions. Keep all script rules (input.<field> only, relative URLs, role/label locators, no coordinates, no fixed waits, only @playwright/test imports, // Step N comments).

${directivesBlock(opts.tc)}
Finish with ONE line of JSON: {"status":"done"|"blocked"|"auth_required","reason":"...","steps_done":[...]}`;
}

export function initialPrompt(tc: TestCase, env: Environment, sample: InputValues, maxActions: number, userPrompt: string, extra = ""): string {
  return `You are training an automated web E2E test script with Playwright.
${UNATTENDED_NOTE}

${testCaseBlock(tc, env, sample)}

${rulesBlock(tc, maxActions)}
${extra ? `\n${extra}\n` : ""}${userPrompt.trim() ? `\n## Additional instructions from the user\n${userPrompt.trim()}` : ""}`;
}

export function revisePrompt(opts: {
  userPrompt: string;
  revisionNo: number | null;
  sample: InputValues;
  tc: TestCase;
  lastRun: RunContext | null;
  maxActions: number;
  extra?: string;
}): string {
  return `Revise the test script.
${UNATTENDED_NOTE}

${opts.revisionNo ? `\`${CANDIDATE_FILE}\` in the working directory contains candidate revision #${opts.revisionNo} (the latest saved version). Edit it in place.` : `\`${CANDIDATE_FILE}\` does not exist yet; create it.`}
Sample input for this turn: ${JSON.stringify(opts.sample)}
${opts.lastRun ? `\n${runContextBlock(opts.lastRun)}\n` : ""}${opts.extra ? `\n${opts.extra}\n` : ""}
## User request
${opts.userPrompt.trim() || "Fix the problems above so the script runs end-to-end."}

You may use the Playwright MCP tools again to re-inspect the pages (budget ${opts.maxActions} browser actions). Keep all script rules from before (input.<field> only, relative URLs, role/label locators, no coordinates, no fixed waits or pacing delays, only @playwright/test imports, // Step N comments). Take one final browser_take_screenshot.

${directivesBlock(opts.tc)}
Finish with ONE line of JSON: {"status":"done"|"blocked"|"auth_required","reason":"...","steps_done":[...]}`;
}

export function bootstrapPrompt(opts: {
  tc: TestCase;
  env: Environment;
  sample: InputValues;
  maxActions: number;
  revisionNo: number | null;
  promptHistory: string[];
  lastRun: RunContext | null;
  userPrompt: string;
  reason: string;
  extra?: string;
}): string {
  const history = opts.promptHistory.slice(-10).map((p, i) => `  ${i + 1}. ${p.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  return `You are continuing the training of an automated web E2E test script with Playwright. ${opts.reason}
${UNATTENDED_NOTE}

${testCaseBlock(opts.tc, opts.env, opts.sample)}

## Saved training state
${opts.revisionNo ? `- \`${CANDIDATE_FILE}\` in the working directory contains the latest candidate revision #${opts.revisionNo}. Start from it.` : `- No candidate script exists yet.`}
${history ? `- earlier user prompts (oldest first):\n${history}` : "- no earlier user prompts"}
${opts.lastRun ? `\n${runContextBlock(opts.lastRun)}` : ""}

${rulesBlock(opts.tc, opts.maxActions)}
${opts.extra ? `\n${opts.extra}\n` : ""}
## User request for this turn
${opts.userPrompt.trim() || "Review the saved script against the manual steps, verify it on the site and improve it where needed."}`;
}

export function repairPrompt(issues: ValidationIssue[]): string {
  const list = issues
    .filter((i) => i.severity === "error")
    .map((i) => `- ${i.line ? `line ${i.line}: ` : ""}[${i.code}] ${i.message}`)
    .join("\n");
  return `\`${CANDIDATE_FILE}\` failed automatic validation:
${list}

Fix \`${CANDIDATE_FILE}\` in place without asking for confirmation (no browser actions are needed unless a locator must be re-checked). Keep the exported \`async function run(page, input)\` signature and use only input.<field> for test data.
Finish with ONE line of JSON: {"status":"done"|"blocked"|"auth_required","reason":"...","steps_done":[...]}`;
}

export interface AgentVerdict {
  status: "done" | "blocked" | "auth_required" | "unknown";
  reason: string;
}

export function parseVerdict(text: string): AgentVerdict {
  const matches = [...text.matchAll(/\{[^{}]*"status"\s*:\s*"(done|blocked|auth_required)"[^{}]*\}/g)];
  const last = matches.at(-1);
  if (!last) return { status: "unknown", reason: "" };
  try {
    const obj = JSON.parse(last[0]);
    return { status: obj.status, reason: String(obj.reason ?? "") };
  } catch {
    return { status: last[1] as AgentVerdict["status"], reason: "" };
  }
}
