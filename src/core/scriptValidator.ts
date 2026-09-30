import ts from "typescript";
import type { InputSchema, InputValues, ScriptValidation, ValidationIssue } from "../shared/types";
import { stepDirectives } from "./stepDirectives";

export const ALLOWED_IMPORTS = new Set(["@playwright/test", "playwright", "playwright/test"]);
const FORBIDDEN_IDENTIFIERS = new Set(["eval", "require", "process", "globalThis", "Function", "module", "exports", "__dirname", "__filename"]);
const COORDINATE_METHODS = new Set(["click", "dblclick", "move", "down", "up", "wheel", "tap"]);
const SECRET_NAME_RE = /^(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token)$/i;

export interface ValidateOptions {
  schema: InputSchema;
  sampleInput: InputValues;
  secretValues?: string[];
  /** Manual steps; used to check the script's screenshots and page.close() against them. */
  steps?: string[];
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function hasAsync(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function findRun(sf: ts.SourceFile): FnLike | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "run" && isExported(stmt)) return stmt;
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "run" && d.initializer) {
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) return d.initializer;
        }
      }
    }
  }
  return null;
}

function literalTexts(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

function isHardcodedSample(literal: string, sample: string): boolean {
  const v = sample.trim();
  if (v.length < 2 || /^(true|false)$/i.test(v)) return false;
  if (literal.trim() === v) return true;
  return v.length >= 4 && literal.includes(v);
}

export function validateScript(source: string, opts: ValidateOptions): ScriptValidation {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationIssue["severity"], code: string, message: string, node?: ts.Node) => {
    const line = node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : undefined;
    issues.push({ severity, code, message, line });
  };

  const sf = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const syntax = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).diagnostics ?? [];
  for (const d of syntax) {
    const line = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    issues.push({ severity: "error", code: "SYNTAX", message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), line });
  }

  const run = findRun(sf);
  let inputName: string | null = null;
  const usedFields = new Set<string>();
  if (!run) {
    add("error", "NO_RUN", "Không tìm thấy `export async function run(page, input)`");
  } else {
    if (!hasAsync(run)) add("error", "RUN_NOT_ASYNC", "Hàm run phải là async", run);
    if (run.parameters.length !== 2) {
      add("error", "RUN_SIGNATURE", "Hàm run phải có đúng 2 tham số (page, input)", run);
    } else {
      const p = run.parameters[1].name;
      if (ts.isIdentifier(p)) inputName = p.text;
      else if (ts.isObjectBindingPattern(p)) {
        for (const el of p.elements) {
          const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
          if (key) usedFields.add(key);
        }
      }
    }
  }

  const schemaNames = new Set(opts.schema.fields.map((f) => f.name));
  const secretSamples = opts.schema.fields.filter((f) => f.secret).map((f) => opts.sampleInput[f.name]).filter(Boolean);
  const secretValues = [...(opts.secretValues ?? []), ...secretSamples].filter((s) => s && s.length >= 3);
  const sampleValues = Object.entries(opts.sampleInput).filter(([k]) => schemaNames.has(k));

  let screenshotCalls = 0;
  let pageCloseCalls = 0;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!ALLOWED_IMPORTS.has(node.moduleSpecifier.text)) {
        add("error", "FORBIDDEN_IMPORT", `Không được import "${node.moduleSpecifier.text}" (chỉ cho phép @playwright/test)`, node);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add("error", "DYNAMIC_IMPORT", "Không được dùng import() động", node);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isMemberName) add("error", "FORBIDDEN_API", `Không được dùng "${node.text}" trong script`, node);
    }

    if (inputName) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === inputName) {
        usedFields.add(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === inputName) {
        const arg = node.argumentExpression;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) usedFields.add(arg.text);
        else add("error", "DYNAMIC_INPUT", "Không truy cập input bằng khóa động; dùng input.<field>", node);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === inputName && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
          if (key) usedFields.add(key);
        }
      }
    }

    const text = literalTexts(node);
    if (text !== null && text.length > 0) {
      const isImportPath = node.parent && ts.isImportDeclaration(node.parent);
      if (!isImportPath) {
        for (const s of secretValues) {
          if (text.includes(s)) add("error", "HARDCODED_SECRET", "Script chứa giá trị secret", node);
        }
        for (const [field, value] of sampleValues) {
          if (secretValues.includes(value)) continue;
          if (isHardcodedSample(text, value)) {
            add("error", "HARDCODED_INPUT", `Giá trị training của "${field}" bị hardcode; dùng input.${field}`, node);
          }
        }
        const parent = node.parent;
        const target =
          parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name && ts.isIdentifier(parent.name)
            ? parent.name.text
            : null;
        if (target && SECRET_NAME_RE.test(target)) add("error", "HARDCODED_SECRET", `"${target}" không được gán giá trị cố định`, node);
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression;
      if (ts.isPropertyAccessExpression(owner) && (owner.name.text === "mouse" || owner.name.text === "touchscreen") && COORDINATE_METHODS.has(method)) {
        add("error", "COORDINATES", `Không dùng tọa độ màn hình (${owner.name.text}.${method}); dùng locator`, node);
      }
      if (method === "click" || method === "dblclick" || method === "hover" || method === "tap") {
        for (const arg of node.arguments) {
          if (ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "position")) {
            add("error", "COORDINATES", "Không dùng tuỳ chọn position (tọa độ) cho click", node);
          }
        }
      }
      if ((method === "setInputFiles" || method === "setFiles") && node.arguments[0]) {
        const first = node.arguments[0];
        const literals = ts.isArrayLiteralExpression(first) ? first.elements : [first];
        if (literals.some((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e))) {
          add("error", "HARDCODED_FILE", "File tải lên phải lấy từ input.<biến kiểu file> (runner truyền đường dẫn file mẫu của dự án), không ghi cố định đường dẫn", node);
        }
      }
      if (method === "screenshot") screenshotCalls++;
      if (method === "close") {
        const viaGetter = ts.isCallExpression(owner) && ts.isPropertyAccessExpression(owner.expression) ? owner.expression.name.text : null;
        const ownerName = ts.isIdentifier(owner) ? owner.text : viaGetter;
        if (ownerName && /^(browser|context)$/i.test(ownerName)) {
          add("warning", "CLOSE_BROWSER", "Đóng browser bằng await page.close(), không đóng context/browser (runner cần context để lưu trace khi lỗi)", node);
        }
        pageCloseCalls++;
      }
      if (method === "waitForTimeout") add("warning", "FIXED_WAIT", "Tránh waitForTimeout; nên chờ theo điều kiện (tốc độ thao tác do runner điều chỉnh)", node);
      if (method === "pause") add("error", "PAUSE", "Không dùng pause(): runner chạy tự động, lệnh này làm Trial/Testing treo đến khi hết thời gian", node);
      if (method === "goto" && node.arguments[0]) {
        const first = node.arguments[0];
        if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && /^https?:\/\//i.test(first.text)) {
          add("warning", "ABSOLUTE_URL", "Nên dùng đường dẫn tương đối với page.goto (baseURL do runner cấp)", node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (opts.steps) {
    const d = stepDirectives(opts.steps);
    const list = (ns: number[]) => ns.join(", ");
    if (d.screenshot.length && screenshotCalls < d.screenshot.length) {
      add("warning", "SCREENSHOT_STEPS", `Steps yêu cầu chụp màn hình ở bước ${list(d.screenshot)} nhưng script chỉ có ${screenshotCalls} lệnh screenshot`);
    } else if (d.screenshot.length && screenshotCalls > d.screenshot.length) {
      add("warning", "SCREENSHOT_STEPS", `Script chụp ${screenshotCalls} ảnh, nhiều hơn số bước yêu cầu chụp (${list(d.screenshot)})`);
    } else if (!d.screenshot.length && screenshotCalls === 0) {
      add("warning", "NO_SCREENSHOT", "Script không chụp màn hình; Trial/Testing sẽ không có ảnh kết quả");
    }
    if (d.close.length && pageCloseCalls === 0) add("warning", "CLOSE_STEP", `Steps yêu cầu đóng browser ở bước ${list(d.close)} nhưng script không gọi page.close()`);
    if (!d.close.length && pageCloseCalls > 0) add("warning", "CLOSE_STEP", "Script tự đóng browser dù steps không yêu cầu");
  }

  for (const f of usedFields) {
    if (!schemaNames.has(f)) add("error", "UNKNOWN_FIELD", `input.${f} không có trong input_schema`);
  }
  for (const f of schemaNames) {
    if (!usedFields.has(f)) issues.push({ severity: "warning", code: "UNUSED_FIELD", message: `input.${f} không được dùng trong script` });
  }

  const dedup = new Map<string, ValidationIssue>();
  for (const i of issues) dedup.set(`${i.code}|${i.line ?? ""}|${i.message}`, i);
  const all = [...dedup.values()];
  return { ok: !all.some((i) => i.severity === "error"), issues: all, used_fields: [...usedFields] };
}

export function transpileScript(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
}
