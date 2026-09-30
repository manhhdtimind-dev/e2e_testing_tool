import ts from "typescript";
import type { InputField, InputSchema, InputValues } from "../shared/types";
import { fieldTsType } from "./inputValidation";
import { replaceLocator } from "./selectorStability";
import { fold, stepDirectives } from "./stepDirectives";

/** The subset of a Playwright recorder action the app keeps (never the aria snapshot: it holds typed values). */
export interface RecordedAction {
  name: string;
  selector?: string;
  text?: string;
  key?: string;
  options?: string[];
  url?: string;
  files?: string[];
}

export type RecordingEvent =
  /** `page` is the tab index (0 = the tab the recording started in); `url` is the tab URL before the action ran. */
  | { kind: "action"; t: number; page: number; url: string; action: RecordedAction; code: string }
  | { kind: "shot"; t: number; url: string }
  | { kind: "step"; t: number; step: number };

export interface RecordingBuildOptions {
  baseUrl: string;
  schema: InputSchema;
  /** Values of non-secret fields the user was asked to type while recording. */
  sample: InputValues;
  /** Secret field → value from the environment; typed secrets are mapped back to input.<field>. */
  secrets: Record<string, string>;
  steps: string[];
  /** Append `await page.close()` (the user reached a "close the browser" step). */
  closeAtEnd: boolean;
  /** Recorder selectors that looked fragile, with the stable locator found on the page (null = none). */
  stable?: Record<string, StableFix>;
}

export interface StableFix {
  reason: string;
  locator: string | null;
}

export interface RecordingBuild {
  source: string;
  notes: string[];
  actionCount: number;
  log: { step: number | null; code: string }[];
}

const pickAction = (a: RecordedAction): RecordedAction => ({
  name: a.name,
  ...(a.selector !== undefined ? { selector: a.selector } : {}),
  ...(a.text !== undefined ? { text: a.text } : {}),
  ...(a.key !== undefined ? { key: a.key } : {}),
  ...(a.options !== undefined ? { options: [...a.options] } : {}),
  ...(a.url !== undefined ? { url: a.url } : {}),
  ...(a.files !== undefined ? { files: [...a.files] } : {}),
});

/** Copies only the fields the build needs from a raw recorder action. */
export function sanitizeRecordedAction(raw: unknown): RecordedAction {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const options = Array.isArray(a.options)
    ? a.options.map((o) => (typeof o === "string" ? o : String((o as { value?: unknown; label?: unknown })?.value ?? (o as { label?: unknown })?.label ?? "")))
    : undefined;
  return pickAction({
    name: str(a.name) ?? "unknown",
    selector: str(a.selector),
    text: str(a.text),
    key: str(a.key),
    options,
    url: str(a.url),
    files: list(a.files),
  });
}

/** Tag of the in-page recording toolbar; the recorder still records clicks on its host element. */
export const TOOLBAR_TAG = "e2e-rec-bar";

const SECRET_TARGET_RE = /pass|mat khau|secret|token|otp|\bpin\b|api.?key|ma bao mat/;
const VALUE_METHODS = new Set(["fill", "type", "pressSequentially", "selectOption"]);
const ID_SEGMENT_RE = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})$/i;

function describeTarget(selector: string | undefined): string {
  if (!selector) return "phần tử";
  const m = selector.match(/(?:name|label|placeholder|text)="([^"]+)"/);
  return `"${(m ? m[1] : selector).slice(0, 60)}"`;
}

function inputRef(field: InputField): string {
  const access = /^[A-Za-z_$][\w$]*$/.test(field.name) ? `input.${field.name}` : `input[${JSON.stringify(field.name)}]`;
  return field.type === "string" || field.type === "file" ? access : `String(${access})`;
}

function templateText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function rootIdentifier(node: ts.Node): string | null {
  let n: ts.Node = node;
  for (;;) {
    if (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isCallExpression(n)) n = n.expression;
    else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression;
    else break;
  }
  return ts.isIdentifier(n) ? n.text : null;
}

function relativeUrl(url: string, baseUrl: string): string | null {
  try {
    const u = new URL(url);
    const base = new URL(baseUrl);
    if (u.origin !== base.origin) return null;
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return null;
  }
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function waitForPath(path: string): string {
  const parts = path.split("/").map((seg) => (ID_SEGMENT_RE.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  return `await page.waitForURL(/${parts.join("\\/")}(?:[?#]|$)/);`;
}

const POPUP_PANEL_CLASS_RE = /dropdown|popper|popover|listbox|menu/i;
const CHOICE_SELECTOR_RE = /^internal:role=(?:option|menuitem(?:radio|checkbox)?|treeitem)\b/;

/** A popup panel a framework renders per open (`#el-id-9173-227 > .el-select-dropdown`); clicking the panel itself does nothing. */
function isPopupPanel(selector: string): boolean {
  if (selector.startsWith("internal:")) return false;
  return [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].some((m) => POPUP_PANEL_CLASS_RE.test(m[1]));
}

function pressKey(e: Extract<RecordingEvent, { kind: "action" }>): string | undefined {
  return e.action.key ?? e.code.match(/\.press\((['"])(.+?)\1\)/)?.[2];
}

/**
 * Drops recorder noise: actions on the toolbar, the focusing click before typing, the synthetic submit click
 * after Enter, a click on a dropdown panel right before picking one of its options, repeated navigations.
 */
export function cleanRecording(events: RecordingEvent[]): RecordingEvent[] {
  events = events.filter((e) => e.kind !== "action" || !(e.action.selector?.includes(TOOLBAR_TAG) || e.code.includes(TOOLBAR_TAG)));
  const out: RecordingEvent[] = [];
  const lastAction = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      const e = out[i];
      if (e.kind === "action") return e;
    }
    return undefined;
  };
  events.forEach((e, i) => {
    if (e.kind !== "action") return out.push(e);
    const a = e.action;
    if (a.name === "openPage" || a.name === "closePage") return;
    if (a.name === "click" && a.selector) {
      const next = events[i + 1];
      if (next?.kind === "action" && (next.action.name === "fill" || next.action.name === "press") && next.action.selector === a.selector) return;
      const prev = lastAction();
      if (prev && prev.action.name === "press" && /^(Numpad)?Enter$/.test(pressKey(prev) ?? "") && e.t - prev.t < 1000 && /role=button|type=submit/i.test(a.selector)) return;
      const nextAction = events.slice(i + 1).find((x): x is Extract<RecordingEvent, { kind: "action" }> => x.kind === "action");
      if (isPopupPanel(a.selector) && nextAction?.action.name === "click" && CHOICE_SELECTOR_RE.test(nextAction.action.selector ?? "")) return;
    }
    if (a.name === "navigate") {
      const prev = lastAction();
      if (prev?.action.name === "navigate" && prev.action.url === a.url) return;
    }
    out.push(e);
  });
  return out;
}

interface Ctx {
  opts: RecordingBuildOptions;
  notes: Set<string>;
  fields: InputField[];
  secretFields: InputField[];
}

/** Rewrites string literals of one recorded statement: test data → input.<field>, URLs → relative. */
function rewriteStatement(stmt: ts.Statement, sf: ts.SourceFile, action: RecordedAction, c: Ctx): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const nonSecret = c.fields.filter((f) => !f.secret && f.type !== "file" && (c.opts.sample[f.name] ?? "") !== "");
  const byValue = (value: string) => nonSecret.filter((f) => c.opts.sample[f.name] === value);
  const secretByValue = (value: string) => c.secretFields.find((f) => value !== "" && c.opts.secrets[f.name] === value);

  const containsSample = (text: string): string | null => {
    const hits = nonSecret.filter((f) => (c.opts.sample[f.name] ?? "").trim().length >= 4 && text.includes(c.opts.sample[f.name]));
    if (!hits.length) return null;
    hits.sort((a, b) => c.opts.sample[b.name].length - c.opts.sample[a.name].length);
    let parts: { text: string; field?: InputField }[] = [{ text }];
    for (const f of hits) {
      const v = c.opts.sample[f.name];
      parts = parts.flatMap((p) => (p.field ? [p] : p.text.split(v).flatMap((t, i) => (i ? [{ text: "", field: f }, { text: t }] : [{ text: t }]))));
    }
    return "`" + parts.map((p) => (p.field ? `\${input.${p.field.name}}` : templateText(p.text))).join("") + "`";
  };

  const secretFallback = (): string => {
    const target = fold(action.selector ?? "");
    const named = c.secretFields.find((f) => target.includes(fold(f.name).replace(/_/g, " ")) || target.includes(fold(f.name)));
    const field = named ?? (c.secretFields.length === 1 ? c.secretFields[0] : undefined);
    if (field) {
      if (!c.opts.secrets[field.name]) c.notes.add(`Ô ${describeTarget(action.selector)}: đã dùng input.${field.name} cho giá trị bí mật vừa nhập (environment chưa lưu giá trị của biến này).`);
      return inputRef(field);
    }
    c.notes.add(
      `Ô ${describeTarget(action.selector)} trông như mật khẩu/mã bí mật nhưng test case chưa có biến secret phù hợp: giá trị đã bị xoá khỏi script. Thêm biến (đánh dấu secret, lưu giá trị ở Environment) rồi sửa dòng này.`,
    );
    return '""';
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text;
      const call = ts.isArrayLiteralExpression(node.parent) ? node.parent.parent : node.parent;
      const method = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
      const isFirstArg = !!call && ts.isCallExpression(call) && (call.arguments[0] === node || call.arguments[0] === node.parent);
      let text: string | null = null;

      if (method === "goto" && isFirstArg) {
        const rel = relativeUrl(value, c.opts.baseUrl);
        if (rel !== null) text = JSON.stringify(rel);
        else c.notes.add(`Có lệnh mở trang ngoài base URL của environment (${value.slice(0, 80)}); kiểm tra lại allowed domains.`);
      } else if (method && VALUE_METHODS.has(method) && isFirstArg) {
        const same = byValue(value);
        const secret = secretByValue(value);
        if (secret) text = inputRef(secret);
        else if (same.length) {
          if (same.length > 1) c.notes.add(`Giá trị nhập ở ô ${describeTarget(action.selector)} trùng input mẫu của nhiều biến (${same.map((f) => f.name).join(", ")}); đã dùng input.${same[0].name}.`);
          text = inputRef(same[0]);
        } else if (method !== "selectOption" && value !== "" && SECRET_TARGET_RE.test(fold(action.selector ?? ""))) {
          text = secretFallback();
        } else if (method !== "selectOption" && value !== "") {
          text = containsSample(value);
          if (!text) c.notes.add(`Ô ${describeTarget(action.selector)}: giá trị nhập không khớp input mẫu nên đang được ghi cố định trong script.`);
        }
      } else {
        const secret = secretByValue(value);
        const same = value.trim().length >= 3 ? byValue(value) : [];
        if (secret) text = inputRef(secret);
        else if (same.length) text = inputRef(same[0]);
        else text = containsSample(value);
      }
      if (text !== null) edits.push({ start: node.getStart(sf), end: node.getEnd(), text });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(stmt);

  let out = sf.text.slice(stmt.getStart(sf), stmt.getEnd());
  const base = stmt.getStart(sf);
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start - base) + e.text + out.slice(e.end - base);
  return out;
}

/** Chromium's value of a file input; the recorder's api mode reports a file choice as `fill` with this value. */
const FAKEPATH_RE = /^[A-Za-z]:\\fakepath\\(.+)$/;

const isUpload = (a: RecordedAction) => a.name === "setInputFiles" || (a.name === "fill" && FAKEPATH_RE.test(a.text ?? ""));

/**
 * The recorder only knows the names of the chosen files. A single file is mapped to the file field whose sample value
 * is that name (or to the only file field); anything else stays for the user to fix.
 */
function uploadStatements(e: Extract<RecordingEvent, { kind: "action" }>, c: Ctx): string[] {
  const target = describeTarget(e.action.selector);
  const fakePath = e.action.name === "fill" ? (e.action.text ?? "").match(FAKEPATH_RE)?.[1] : undefined;
  const files = (fakePath ? [fakePath] : (e.action.files ?? [])).map((f) => f.split(/[\\/]/).pop() ?? f);
  const manual = (why: string) => {
    c.notes.add(`Bước tải file lên ô ${target}: ${why}; cần sửa tay.`);
    return [`// Cần sửa: tải file lên ô ${target}`];
  };
  const sf = ts.createSourceFile("recorded.ts", e.code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const method = e.action.name;
  let call: (ts.CallExpression & { expression: ts.PropertyAccessExpression }) | undefined;
  const find = (n: ts.Node) => {
    if (!call && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === method) {
      call = n as ts.CallExpression & { expression: ts.PropertyAccessExpression };
    } else ts.forEachChild(n, find);
  };
  find(sf);
  const stmt = sf.statements.find((s) => call && s.getStart(sf) <= call.getStart(sf) && call.getEnd() <= s.getEnd());
  if (!call || !stmt || !call.arguments[0] || rootIdentifier(call) !== "page") return manual("không đọc được lệnh đã ghi");
  if (!files.length) return [sf.text.slice(stmt.getStart(sf), stmt.getEnd())];
  if (files.length > 1) return manual(`đã chọn ${files.length} file cùng lúc (chỉ hỗ trợ một file cho mỗi biến kiểu file)`);

  const fileFields = c.fields.filter((f) => f.type === "file" && !f.secret);
  if (!fileFields.length) return manual(`test case chưa có biến kiểu file cho file "${files[0]}" (thêm biến kiểu file và file mẫu của dự án)`);
  const same = fileFields.filter((f) => c.opts.sample[f.name] === files[0]);
  const field = same[0] ?? (fileFields.length === 1 ? fileFields[0] : undefined);
  if (!field) return manual(`file "${files[0]}" không khớp input mẫu của biến kiểu file nào`);
  if (!same.length) {
    c.notes.add(`Ô ${target}: file đã chọn lúc ghi ("${files[0]}") khác input mẫu của ${field.name}; script dùng input.${field.name}.`);
  }
  const name = call.expression.name;
  const arg = call.arguments[0];
  const text = sf.text;
  return [
    text.slice(stmt.getStart(sf), name.getStart(sf)) + "setInputFiles" + text.slice(name.getEnd(), arg.getStart(sf)) + inputRef(field) + text.slice(arg.getEnd(), stmt.getEnd()),
  ];
}

/** Swaps a fragile recorder locator for the stable one found while recording, or flags it for a manual fix. */
function withStableLocator(e: Extract<RecordingEvent, { kind: "action" }>, c: Ctx): { event: typeof e; flag: string | null } {
  const fix = e.action.selector ? c.opts.stable?.[e.action.selector] : undefined;
  if (!fix) return { event: e, flag: null };
  const code = fix.locator ? replaceLocator(e.code, fix.locator) : null;
  if (code) return { event: { ...e, code }, flag: null };
  c.notes.add(`Phần tử ${describeTarget(e.action.selector)}: selector dễ đổi (${fix.reason}) và không tìm được selector ổn định thay thế; sửa tay hoặc Training lại bước này.`);
  return { event: e, flag: `// Cần sửa: selector dễ đổi (${fix.reason})` };
}

function statementsFor(action: Extract<RecordingEvent, { kind: "action" }>, c: Ctx): string[] {
  if (action.page > 0) {
    c.notes.add("Có thao tác trên tab/cửa sổ khác lúc ghi; các thao tác đó không được đưa vào script (script chỉ chạy trên một tab).");
    return [];
  }
  const { event: e, flag } = withStableLocator(action, c);
  const out = isUpload(e.action) ? uploadStatements(e, c) : recordedStatements(e, c);
  return flag && out.length ? [flag, ...out] : out;
}

function recordedStatements(e: Extract<RecordingEvent, { kind: "action" }>, c: Ctx): string[] {
  const sf = ts.createSourceFile("recorded.ts", e.code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && rootIdentifier(stmt.expression) === "page") out.push(rewriteStatement(stmt, sf, e.action, c));
    else if (/\bpage\d+\b/.test(stmt.getText(sf))) {
      c.notes.add("Thao tác mở tab/cửa sổ mới (popup) chưa được hỗ trợ đầy đủ khi ghi; kiểm tra lại đoạn này.");
    }
  }
  return out;
}

function typeLiteral(schema: InputSchema): string {
  return `{ ${schema.fields.map((f) => `${/^[A-Za-z_$][\w$]*$/.test(f.name) ? f.name : JSON.stringify(f.name)}: ${fieldTsType(f.type)}`).join("; ")} }`;
}

const indent = (code: string) =>
  code
    .split("\n")
    .map((l, i) => (i === 0 ? `  ${l.trimStart()}` : `  ${l}`))
    .join("\n");

/** Turns a recording into a candidate script following the app's `run(page, input)` contract. */
export function buildRecordedScript(events: RecordingEvent[], opts: RecordingBuildOptions): RecordingBuild {
  const c: Ctx = { opts, notes: new Set(), fields: opts.schema.fields, secretFields: opts.schema.fields.filter((f) => f.secret) };
  const body: string[] = [];
  const log: RecordingBuild["log"] = [];
  let step: number | null = null;
  let lastUrl: string | null = null;
  let actionCount = 0;
  let navigated = false;

  const stepComment = (n: number) => {
    const text = (opts.steps[n - 1] ?? "").replace(/\s+/g, " ").trim();
    return `// Step ${n}${text ? `: ${text}` : ""}`;
  };
  const emit = (code: string) => {
    body.push(indent(code));
    log.push({ step, code });
  };

  for (const e of cleanRecording(events)) {
    if (e.kind === "step") {
      if (e.step === step) continue;
      step = e.step;
      if (body.length && /^\s*\/\/ Step /.test(body[body.length - 1])) body.pop();
      body.push(indent(stepComment(e.step)));
      continue;
    }
    if (e.kind === "shot") {
      const shotPath = pathOf(e.url);
      if (shotPath && lastUrl && pathOf(lastUrl) !== shotPath && relativeUrl(e.url, opts.baseUrl) !== null) emit(waitForPath(shotPath));
      emit("await page.screenshot();");
      lastUrl = e.url;
      continue;
    }
    const stmts = statementsFor(e, c);
    if (!stmts.length) continue;
    if (e.action.name === "navigate") navigated = true;
    else if (!navigated) {
      const rel = relativeUrl(opts.baseUrl, opts.baseUrl) ?? "/";
      emit(`await page.goto(${JSON.stringify(rel)});`);
      navigated = true;
    }
    for (const s of stmts) emit(s);
    actionCount++;
    lastUrl = e.action.name === "navigate" && e.action.url ? e.action.url : e.url;
  }
  if (body.length && /^\s*\/\/ Step /.test(body[body.length - 1])) body.pop();

  if (opts.closeAtEnd) {
    const closeStep = stepDirectives(opts.steps).close.at(-1);
    if (closeStep && !body.some((l) => l.trim() === stepComment(closeStep))) body.push(indent(stepComment(closeStep)));
    emit("await page.close();");
  }

  const notes = [...c.notes];
  const header = notes.length ? ["// Ghi thao tác — cần xem lại:", ...notes.map((n) => `// - ${n}`), ""] : [];
  const source = [
    'import type { Page } from "@playwright/test";',
    "",
    ...header,
    `type Input = ${typeLiteral(opts.schema)};`,
    "",
    "export async function run(page: Page, input: Input): Promise<void> {",
    ...body,
    "}",
    "",
  ].join("\n");
  return { source, notes, actionCount, log };
}
