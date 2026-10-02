import ts from "typescript";

/** Ids that UI frameworks generate per page load (Element Plus, React useId, MUI, Radix, Headless UI, …). */
const GENERATED_ID_RE =
  /^(?:el-id-\d+-\d+|:r[0-9a-z]*:|«r[0-9a-z]*»|mui-\d+|radix-.+|headlessui-.+|react-select-\d+-.+|rc_select_\d+|ember\d+|ext-gen\d+|pr_id_\d+|mat-[a-z-]+-\d+|cdk-[a-z-]+-\d+|downshift-\d+-.+|[0-9a-f]{8}-[0-9a-f]{4}-.+)$/i;

/** Layout/utility classes (Tailwind, Bootstrap grid) describe looks, not the element; they change with the design. */
export const UTILITY_CLASS_RE =
  /^(?:[a-z0-9]+:)*-?(?:flex|inline-flex|grid|inline-grid|block|inline-block|inline|hidden|contents|table|relative|absolute|fixed|sticky|static|truncate|grow|shrink|container|clearfix|row|col|visible|invisible|(?:min-|max-)?[wh]-.+|size-.+|[mp][trblxyse]?-.+|gap(?:-[xy])?-.+|space-[xy]-.+|text-.+|font-.+|leading-.+|tracking-.+|bg-.+|from-.+|to-.+|border(?:-.+)?|rounded(?:-.+)?|shadow(?:-.+)?|opacity-.+|z-.+|top-.+|left-.+|right-.+|bottom-.+|inset-.+|items-.+|justify-.+|content-.+|self-.+|place-.+|order-.+|basis-.+|overflow-.+|cursor-.+|select-none|transition(?:-.+)?|duration-.+|ease-.+|delay-.+|col-.+|row-.+|d-.+|align-.+|float-.+|whitespace-.+|break-.+|line-clamp-.+|ring(?:-.+)?|outline-.+|fill-.+|stroke-.+|aspect-.+|object-.+|flex-.+|grid-.+|pointer-events-.+|sr-only|antialiased|underline|uppercase|lowercase|capitalize|italic)$/;

/** CSS-in-JS / CSS-modules hashes: `css-1x2y3z`, `sc-bdVaJa`, `Button_root__a1B2c`. */
export const HASH_CLASS_RE = /^(?:css|sc|jsx|emotion|svelte|styled|jss|makeStyles)[-_][\w-]+$|(?:^|[_-])(?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{5,}$/;

/** Classes that only reflect the current state of the element. */
export const STATE_CLASS_RE = /^(?:is-.+|has-.+|ng-.+|active|focus(?:ed)?|hover(?:ed)?|selected|disabled|open(?:ed)?|show(?:n)?|checked|current|visible|expanded|collapsed)$/;

export function isGeneratedId(id: string): boolean {
  return GENERATED_ID_RE.test(id) || /\d{3,}/.test(id);
}

const unescapeCss = (s: string) => s.replace(/\\(.)/g, "$1");

/** Why a CSS selector is likely to break when the page is reloaded or restyled; null when it looks stable. */
export function cssFragility(css: string): string | null {
  const reasons: string[] = [];
  for (const m of css.matchAll(/#((?:\\.|[\w-])+)|\[id\s*=\s*["']([^"']+)["']\]/g)) {
    const id = m[1] !== undefined ? unescapeCss(m[1]) : m[2];
    if (isGeneratedId(id)) reasons.push(`id tự sinh "#${id}"`);
  }
  const classes = [...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => unescapeCss(m[1]));
  const hashed = classes.filter((c) => HASH_CLASS_RE.test(c));
  if (hashed.length) reasons.push(`class dạng mã băm "${hashed.map((c) => `.${c}`).join("")}"`);
  const utility = classes.filter((c) => UTILITY_CLASS_RE.test(c));
  if (utility.length) reasons.push(`class bố cục "${utility.map((c) => `.${c}`).join("")}"`);
  const state = classes.filter((c) => STATE_CLASS_RE.test(c));
  if (state.length) reasons.push(`class trạng thái "${state.map((c) => `.${c}`).join("")}"`);
  if ((css.match(/>/g) ?? []).length >= 2) reasons.push("chuỗi CSS bám theo cấu trúc trang");
  return reasons.length ? reasons.join(", ") : null;
}

/** Same check for a Playwright selector as reported by the recorder (`css >> internal:… >> nth=1`). */
export function fragileReason(selector: string | undefined): string | null {
  if (!selector) return null;
  const reasons = new Set<string>();
  for (const part of selector.split(/\s*>>\s*/)) {
    if (/^nth=/.test(part)) reasons.add("phụ thuộc thứ tự phần tử (nth)");
    else if (!part.startsWith("internal:")) {
      const r = cssFragility(part.replace(/^css=/, ""));
      if (r) reasons.add(r);
    }
  }
  return reasons.size ? [...reasons].join(", ") : null;
}

/** A locator the app builds itself, as data, so it can be both checked with Playwright and written as code. */
export type LocatorSpec =
  | { kind: "testid"; value: string }
  | { kind: "attr"; tag: string; attr: string; value: string }
  | { kind: "label"; text: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "css"; selector: string }
  /** The element inside the nearest container (e.g. a form item) that shows `label`. */
  | { kind: "within"; container: string; label: string; inner: Exclude<LocatorSpec, { kind: "within" }> };

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

export function attrSelector(spec: { tag: string; attr: string; value: string }): string {
  return `${spec.tag}[${spec.attr}=${JSON.stringify(spec.value)}]`;
}

export function specToCode(spec: LocatorSpec, root = "page"): string {
  switch (spec.kind) {
    case "testid":
      return `${root}.getByTestId(${q(spec.value)})`;
    case "attr":
      return `${root}.locator(${q(attrSelector(spec))})`;
    case "label":
      return `${root}.getByLabel(${q(spec.text)}, { exact: true })`;
    case "role":
      return spec.name ? `${root}.getByRole(${q(spec.role)}, { name: ${q(spec.name)}, exact: true })` : `${root}.getByRole(${q(spec.role)})`;
    case "css":
      return `${root}.locator(${q(spec.selector)})`;
    case "within":
      return specToCode(spec.inner, `${root}.locator(${q(spec.container)}).filter({ has: page.getByText(${q(spec.label)}, { exact: true }) })`);
  }
}

/**
 * Replaces the locator of a recorded statement (`await <locator>.click()`) with `locator`.
 * Returns null when the code does not have that shape.
 */
const FILE_NAME_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|heic|mp4|mov|webm|avi|pdf|docx?|xlsx?|csv|pptx?|zip|txt)\b/i;
const DATE_TIME_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const LONG_NUMBER_RE = /\d{5,}/;

/**
 * Why a locator text looks like a specific piece of data (a file in a library, a dated record, an order/SKU number)
 * rather than a UI label: such items may be gone, renamed or different on the next run or in another environment.
 */
export function dataLikeReason(text: string): string | null {
  if (FILE_NAME_RE.test(text)) return "tên file";
  if (DATE_TIME_RE.test(text)) return "ngày giờ";
  if (LONG_NUMBER_RE.test(text)) return "mã số";
  return null;
}

export const shorten = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const TEXT_LOCATOR_METHODS = new Set(["getByText", "getByLabel", "getByAltText", "getByTitle", "getByPlaceholder"]);

/** Literal texts a locator call matches elements by: `getByText('…')`, `getByRole(…, { name: '…' })`, `filter({ hasText: '…' })`. */
export function locatorTexts(call: ts.CallExpression): string[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const method = call.expression.name.text;
  const literal = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? [n.text] : []);
  const option = (n: ts.Node | undefined, key: string) =>
    n && ts.isObjectLiteralExpression(n)
      ? n.properties.flatMap((p) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key ? literal(p.initializer) : []))
      : [];
  if (TEXT_LOCATOR_METHODS.has(method)) return literal(call.arguments[0]);
  if (method === "getByRole") return option(call.arguments[1], "name");
  if (method === "filter") return option(call.arguments[0], "hasText");
  return [];
}

export function replaceLocator(code: string, locator: string): string | null {
  const span = locatorSpan(code);
  return span ? code.slice(0, span.start) + locator + code.slice(span.end) : null;
}

/** The `page.…` locator a recorded statement acts on, e.g. `page.getByRole('button', { name: 'Save' })`. */
export function locatorOf(code: string): string | null {
  const span = locatorSpan(code);
  return span ? code.slice(span.start, span.end) : null;
}

function locatorSpan(code: string): { start: number; end: number } | null {
  const sf = ts.createSourceFile("recorded.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = ts.isAwaitExpression(stmt.expression) ? stmt.expression.expression : stmt.expression;
    if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) continue;
    const target = expr.expression.expression;
    if (ts.isIdentifier(target)) continue;
    let root: ts.Node = target;
    while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) root = root.expression;
    if (!ts.isIdentifier(root) || root.text !== "page") continue;
    return { start: target.getStart(sf), end: target.getEnd() };
  }
  return null;
}
