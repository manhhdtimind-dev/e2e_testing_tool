import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestCase } from "../../shared/types";
import { pickReferences, referenceFile, referenceFileName, referenceIndex, type ReferenceScript } from "../../core/projectReferences";
import type { AppContext } from "../context";
import { REFERENCE_DIR } from "./prompt";

const MAX_REFERENCES = 6;
const MAX_REFERENCE_CHARS = 60_000;

/** Latest APPROVED version of every other test case in the same project. */
export function approvedProjectScripts(ctx: AppContext, tc: TestCase): ReferenceScript[] {
  if (!tc.project_id) return [];
  const out: ReferenceScript[] = [];
  for (const other of ctx.repo.testCases.where("project_id = ? AND test_id != ?", tc.project_id, tc.test_id)) {
    const script = ctx.repo.scripts.where("test_id = ?", other.test_id)[0];
    if (!script) continue;
    const version = ctx.repo.versions.where("script_id = ? AND status = 'APPROVED' ORDER BY version_no DESC LIMIT 1", script.script_id)[0];
    if (!version) continue;
    out.push({
      test_id: other.test_id,
      title: other.title,
      group_name: other.group_name,
      steps: other.steps,
      version_no: version.version_no,
      approved_at: version.approved_at,
      source: version.source,
    });
  }
  return out;
}

/** Rewrites `<workspace>/reference/` with the most relevant approved scripts of the project; returns what was written. */
export function writeProjectReferences(ctx: AppContext, tc: TestCase, workspace: string): ReferenceScript[] {
  const dir = join(workspace, REFERENCE_DIR);
  rmSync(dir, { recursive: true, force: true });
  if (!ctx.settings().training_project_refs) return [];
  const picked = pickReferences(tc, approvedProjectScripts(ctx, tc), { max: MAX_REFERENCES, maxChars: MAX_REFERENCE_CHARS });
  if (!picked.length) return [];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), referenceIndex(picked));
  for (const r of picked) writeFileSync(join(dir, referenceFileName(r.test_id)), referenceFile(r));
  return picked;
}
