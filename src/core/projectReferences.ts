import ts from "typescript";
import { fold } from "./stepDirectives";

/** Latest APPROVED version of another test case in the same project. */
export interface ReferenceScript {
  test_id: string;
  title: string;
  group_name: string;
  steps: string[];
  version_no: number;
  approved_at: string;
  source: string;
}

export interface ReferenceTarget {
  title: string;
  group_name: string;
  steps: string[];
}

export interface ScriptSummary {
  urls: string[];
  locators: string[];
}

const LOCATOR_METHODS = new Set(["getByRole", "getByLabel", "getByText", "getByTestId", "getByPlaceholder", "getByTitle", "getByAltText", "locator"]);
const URL_METHODS = new Set(["goto", "waitForURL"]);

function tokens(text: string): Set<string> {
  return new Set(
    fold(text)
      .replace(/\{\{[^}]*\}\}/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.sqrt(a.size * b.size);
}

/**
 * Most similar references first (title + steps, same group gets a bonus, newer approvals break ties),
 * capped by count and by total source size so the prompt workspace stays small.
 */
export function pickReferences(target: ReferenceTarget, refs: ReferenceScript[], limits: { max: number; maxChars: number }): ReferenceScript[] {
  const want = tokens([target.title, ...target.steps].join(" "));
  const ranked = refs
    .map((r) => ({
      r,
      score: similarity(want, tokens([r.title, ...r.steps].join(" "))) + (target.group_name && r.group_name === target.group_name ? 0.2 : 0),
    }))
    .sort((x, y) => y.score - x.score || y.r.approved_at.localeCompare(x.r.approved_at));
  const out: ReferenceScript[] = [];
  let chars = 0;
  for (const { r } of ranked) {
    if (out.length >= limits.max) break;
    if (chars + r.source.length > limits.maxChars) continue;
    out.push(r);
    chars += r.source.length;
  }
  return out;
}

/** Pages and locators a script uses, read from its AST (no execution). */
export function summarizeScript(source: string): ScriptSummary {
  const sf = ts.createSourceFile("ref.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const urls = new Set<string>();
  const locators = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const arg = node.arguments[0];
      if (URL_METHODS.has(name) && arg && (ts.isStringLiteralLike(arg) || ts.isRegularExpressionLiteral(arg))) {
        urls.add(arg.text);
      }
      if (LOCATOR_METHODS.has(name) && node.arguments.length) {
        locators.add(`${name}(${node.arguments.map((a) => a.getText(sf)).join(", ")})`.replace(/\s+/g, " "));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { urls: [...urls], locators: [...locators].slice(0, 40) };
}

export function referenceFileName(testId: string): string {
  return `${testId.replace(/[^\w.-]/g, "_")}.ts`;
}

/** reference/README.md: what each approved script does, which pages it visits and which locators it relies on. */
export function referenceIndex(refs: ReferenceScript[]): string {
  const sections = refs.map((r) => {
    const s = summarizeScript(r.source);
    return [
      `## ${r.test_id} — ${r.title} (v${r.version_no}, file \`${referenceFileName(r.test_id)}\`)`,
      "Manual steps:",
      ...r.steps.map((step, i) => `${i + 1}. ${step}`),
      s.urls.length ? `Pages: ${s.urls.map((u) => `\`${u}\``).join(", ")}` : "Pages: (no explicit navigation)",
      s.locators.length ? `Locators:\n${s.locators.map((l) => `- \`${l}\``).join("\n")}` : "Locators: (none)",
    ].join("\n");
  });
  return [
    "# Approved scripts from the same project",
    "",
    "Each file is the latest APPROVED version of another test case in this project: it ran on this site and a person accepted it.",
    "Reuse navigation, locators and waits for the same pages. Test data in them comes from their own input — never copy values.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

export function referenceFile(r: ReferenceScript): string {
  return `// Reference only (read-only): ${r.test_id} — ${r.title}, approved version v${r.version_no}.\n${r.source}`;
}
