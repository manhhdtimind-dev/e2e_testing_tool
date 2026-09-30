import type { ElementHandle, Locator, Page } from "playwright";
import { attrSelector, HASH_CLASS_RE, specToCode, STATE_CLASS_RE, UTILITY_CLASS_RE, type LocatorSpec } from "../../core/selectorStability";

interface CandidateConfig {
  utility: string;
  hash: string;
  state: string;
}

/**
 * Runs inside the page (serialized by Playwright): must stay self-contained.
 * Lists locators for `el`, most stable first; the caller keeps the first one that finds exactly `el`.
 */
function collectCandidates(el: Element, cfg: CandidateConfig): LocatorSpec[] {
  const utility = new RegExp(cfg.utility);
  const hash = new RegExp(cfg.hash);
  const state = new RegExp(cfg.state);
  const stableClasses = (e: Element) => [...e.classList].filter((c) => c.length >= 3 && !utility.test(c) && !hash.test(c) && !state.test(c));
  const textOf = (e: Element) => (e.textContent ?? "").replace(/\s+/g, " ").trim();
  const tag = el.tagName.toLowerCase();
  const implicitRole = (): string | null => {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "input") {
      if (type === "checkbox" || type === "radio") return type;
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (["text", "email", "tel", "url"].includes(type)) return "textbox";
      return null;
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    return null;
  };

  const out: LocatorSpec[] = [];
  for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]) {
    const v = el.getAttribute(attr);
    if (v) out.push(attr === "data-testid" ? { kind: "testid", value: v } : { kind: "attr", tag: "", attr, value: v });
  }
  const name = el.getAttribute("name");
  if (name && ["input", "select", "textarea", "button"].includes(tag)) out.push({ kind: "attr", tag, attr: "name", value: name });
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) out.push({ kind: "label", text: aria });

  const role = el.getAttribute("role") ?? implicitRole();
  const inner: Exclude<LocatorSpec, { kind: "within" }>[] = [];
  if (role) inner.push({ kind: "role", role });
  for (const c of stableClasses(el)) inner.push({ kind: "css", selector: `.${CSS.escape(c)}` });
  inner.push({ kind: "css", selector: tag });

  let node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
    const classes = stableClasses(node);
    if (!classes.length) continue;
    const label = [...node.querySelectorAll("label, legend, [class*='label' i], th, dt")]
      .filter((l) => !l.contains(el))
      .map(textOf)
      .find((t) => t && t.length <= 60);
    if (!label) continue;
    for (const c of classes.slice(0, 2)) for (const i of inner) out.push({ kind: "within", container: `.${CSS.escape(c)}`, label, inner: i });
    break;
  }
  for (const c of stableClasses(el)) out.push({ kind: "css", selector: `.${CSS.escape(c)}` });
  return out;
}

function toLocator(page: Page, spec: LocatorSpec, root: Page | Locator = page): Locator {
  switch (spec.kind) {
    case "testid":
      return root.getByTestId(spec.value);
    case "attr":
      return root.locator(attrSelector(spec));
    case "label":
      return root.getByLabel(spec.text, { exact: true });
    case "role":
      return spec.name ? root.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: true }) : root.getByRole(spec.role as Parameters<Page["getByRole"]>[0]);
    case "css":
      return root.locator(spec.selector);
    case "within":
      return toLocator(page, spec.inner, root.locator(spec.container).filter({ has: page.getByText(spec.label, { exact: true }) }));
  }
}

async function findsExactly(page: Page, spec: LocatorSpec, target: ElementHandle): Promise<boolean> {
  const loc = toLocator(page, spec);
  if ((await loc.count()) !== 1) return false;
  return loc.evaluate((e, t) => e === t, target, { timeout: 1000 });
}

/**
 * Code of a stable locator for the element `selector` points at right now, or null when none was found.
 * Called right after the recorder reported an action whose selector looks fragile.
 */
export async function findStableLocator(page: Page, selector: string): Promise<string | null> {
  if (selector.includes("enter-frame")) return null;
  const target = page.locator(selector);
  if ((await target.count()) !== 1) return null;
  const handle = await target.elementHandle({ timeout: 1000 });
  if (!handle) return null;
  try {
    const cfg: CandidateConfig = { utility: UTILITY_CLASS_RE.source, hash: HASH_CLASS_RE.source, state: STATE_CLASS_RE.source };
    const candidates = await handle.evaluate(collectCandidates, cfg);
    for (const spec of candidates) {
      if (await findsExactly(page, spec, handle).catch(() => false)) return specToCode(spec);
    }
    return null;
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}
