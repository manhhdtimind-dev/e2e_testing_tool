import type { ElementHandle, Locator, Page } from "playwright";
import { TOOLBAR_TAG } from "../../core/recording";
import { attrSelector, HASH_CLASS_RE, specToCode, STATE_CLASS_RE, UTILITY_CLASS_RE, type LocatorSpec } from "../../core/selectorStability";

type TargetKind = "click" | "input" | "change";

/** Which DOM event marks the element a recorded action ran on. */
function targetKind(actionName: string): TargetKind | null {
  if (actionName === "click") return "click";
  if (actionName === "fill") return "input";
  if (["selectOption", "check", "uncheck", "setInputFiles"].includes(actionName)) return "change";
  return null;
}

/**
 * Init script for the recording browser: remembers the element of each user event, with its text at that moment.
 * The recorder reports a click up to ~0.5 s later (it waits for a possible double click) and the stable-locator lookup
 * runs after that, when the recorder selector (e.g. `getByText('Select') >> nth=0`) may point at another element.
 * `__e2eTake("click", hints)` hands out clicks in order: the first unused one whose text/attributes contain a hint from
 * the recorder selector (else the first unused one); earlier unused clicks (ones the recorder skipped) are dropped.
 * Mirrors the clicks the recorder records: trusted left clicks from the mouse, not on checkboxes/radios/ranges.
 * On pointerdown (before the page moves focus) it also notes which elements on the path had a box, so the lookup
 * never picks a part that only has a size while focused (`__e2eShown`).
 */
export const TARGET_CAPTURE_SCRIPT = `(() => {
  if (window.top !== window || window.__e2eTargets) return;
  const list = (window.__e2eTargets = []);
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const describe = (e) => e ? [e.textContent && e.textContent.length < 2000 ? e.textContent : "", e.id, e.getAttribute("placeholder"), e.getAttribute("aria-label"),
    e.getAttribute("title"), e.getAttribute("alt"), e.getAttribute("name"), e.value].map(norm).join("\\n") : "";
  const target = (e) => (e.composedPath ? e.composedPath()[0] : e.target);
  let pressed = null;
  addEventListener("pointerdown", (e) => {
    const el = target(e);
    if (!(el instanceof Element)) return;
    const shown = new Set();
    for (let n = el, i = 0; n && n !== document.documentElement && i < 30; n = n.parentElement, i++) {
      const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
      if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden") shown.add(n);
    }
    pressed = { el, shown };
  }, true);
  const track = (type, kind) => addEventListener(type, (e) => {
    const el = target(e);
    if (!(el instanceof Element) || el.closest(${JSON.stringify(TOOLBAR_TAG)})) return;
    if (kind === "click" && (!e.isTrusted || e.detail === 0 || e.button !== 0 || (el instanceof HTMLInputElement && ["checkbox", "radio", "range"].includes(el.type)))) return;
    const around = el.closest("button, a, label, [role], [tabindex]");
    const shown = kind === "click" && pressed && (pressed.el === el || pressed.el.contains(el) || el.contains(pressed.el)) ? pressed.shown : null;
    if (kind === "click") pressed = null;
    list.push({ kind, el, t: Date.now(), used: false, shown, text: describe(el) + "\\n" + (around && around !== el ? describe(around) : "") });
    if (list.length > 100) list.shift();
  }, true);
  window.__e2eShown = (el, clicked) => {
    const entry = list.find((x) => x.kind === "click" && x.el === clicked);
    if (!entry || !entry.shown) return el;
    for (let n = el; n; n = n.parentElement) if (entry.shown.has(n)) return n;
    return el;
  };
  track("click", "click");
  track("input", "input");
  track("change", "change");
  window.__e2eTake = (kind, hints) => {
    const open = list.filter((x) => x.kind === kind && !x.used);
    const pick = open.find((x) => hints.some((h) => x.text.includes(h))) || open[0];
    if (!pick) return null;
    for (const x of open) {
      x.used = true;
      if (x === pick) break;
    }
    return pick.el.isConnected ? pick.el : null;
  };
  window.__e2eLatest = (kind) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === kind && list[i].el.isConnected) return list[i].el;
    return null;
  };
})();`;

/** Lower-cased texts, ids and attribute values quoted in a recorder selector, e.g. `internal:text="Select"i` → `select`. */
export function selectorHints(selector: string): string[] {
  const out: string[] = [];
  for (const m of selector.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      out.push(m[1]);
    }
  }
  for (const m of selector.matchAll(/#([A-Za-z_][\w-]*)/g)) out.push(m[1]);
  return out.map((s) => s.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
}

/**
 * The element a just-reported action ran on, from the capture script. Must be called for every recorded click,
 * in the order the recorder reports them, so clicks stay paired with their DOM events.
 */
export async function takeActionTarget(page: Page, action: { name: string; selector?: string }): Promise<ElementHandle | null> {
  const kind = targetKind(action.name);
  if (!kind) return null;
  const hints = selectorHints(action.selector ?? "");
  const handle = await page.evaluateHandle(
    ({ kind, hints }) => {
      const w = window as unknown as { __e2eTake?: (k: string, h: string[]) => Element | null; __e2eLatest?: (k: string) => Element | null };
      return (kind === "click" ? w.__e2eTake?.(kind, hints) : w.__e2eLatest?.(kind)) ?? null;
    },
    { kind, hints },
  );
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

interface CandidateConfig {
  utility: string;
  hash: string;
  state: string;
  forClick: boolean;
}

/** `wraps`: the locator finds the widget root that contains the recorded element instead of the element itself. */
interface Candidate {
  spec: LocatorSpec;
  wraps: boolean;
}

/**
 * Runs inside the page (serialized by Playwright): must stay self-contained.
 * Lists locators for `el`, most stable first; the caller keeps the first one that finds exactly `el` (or its widget root).
 */
function collectCandidates(el: Element, cfg: CandidateConfig): Candidate[] {
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

  const out: Candidate[] = [];
  const add = (spec: LocatorSpec, wraps = false) => out.push({ spec, wraps });
  for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]) {
    const v = el.getAttribute(attr);
    if (v) add(attr === "data-testid" ? { kind: "testid", value: v } : { kind: "attr", tag: "", attr, value: v });
  }
  const name = el.getAttribute("name");
  if (name && ["input", "select", "textarea", "button"].includes(tag)) add({ kind: "attr", tag, attr: "name", value: name });
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) add({ kind: "label", text: aria });

  const role = el.getAttribute("role") ?? implicitRole();
  const inner: Exclude<LocatorSpec, { kind: "within" }>[] = [];
  if (role) inner.push({ kind: "role", role });
  for (const c of stableClasses(el)) inner.push({ kind: "css", selector: `.${CSS.escape(c)}` });
  inner.push({ kind: "css", selector: tag });

  // Semantics of HTML/ARIA only: `tabindex="-1"` just allows focus from code and does not make an element a control.
  const interactive = (e: Element) => {
    const t = e.tagName.toLowerCase();
    if (["button", "select", "textarea", "summary", "label"].includes(t) || (t === "a" && e.hasAttribute("href"))) return true;
    if (t === "input" && (e as HTMLInputElement).type !== "hidden") return true;
    if (/^(?:button|link|checkbox|radio|switch|tab|menuitem\w*|option|combobox|textbox|searchbox|spinbutton|slider|treeitem|gridcell)$/.test(e.getAttribute("role") ?? "")) return true;
    const tabindex = e.getAttribute("tabindex");
    return (tabindex !== null && Number(tabindex) >= 0) || (e as HTMLElement).isContentEditable;
  };
  const subControl = (e: Element) => /clear|close|remove|delete|trash|cancel/i.test(`${e.getAttribute("class") ?? ""} ${e.getAttribute("aria-label") ?? ""}`);

  let node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
    const classes = stableClasses(node);
    if (!classes.length) continue;
    const label = [...node.querySelectorAll("label, legend, [class*='label' i], th, dt")]
      .filter((l) => !l.contains(el))
      .map(textOf)
      .find((t) => t && t.length <= 60);
    if (!label) continue;
    // A click on a non-control part of a field widget (layout box, placeholder, icon) replays on the widget root: inner parts
    // may have no size until hovered/focused, the root is always laid out. Not for controls or clear/close buttons.
    const path: Element[] = [];
    for (let n: Element | null = el; n && n !== node; n = n.parentElement) path.unshift(n);
    const widget = path.find((n) => stableClasses(n).length);
    if (cfg.forClick && widget && widget !== el && !path.some((n) => interactive(n) || subControl(n))) {
      for (const c of classes.slice(0, 2))
        for (const w of stableClasses(widget).slice(0, 2)) add({ kind: "within", container: `.${CSS.escape(c)}`, label, inner: { kind: "css", selector: `.${CSS.escape(w)}` } }, true);
    }
    for (const c of classes.slice(0, 2)) for (const i of inner) add({ kind: "within", container: `.${CSS.escape(c)}`, label, inner: i });
    break;
  }
  for (const c of stableClasses(el)) add({ kind: "css", selector: `.${CSS.escape(c)}` });
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

async function findsExactly(page: Page, { spec, wraps }: Candidate, target: ElementHandle): Promise<boolean> {
  const loc = toLocator(page, spec);
  if ((await loc.count()) !== 1) return false;
  return loc.evaluate((e, [t, w]) => e === t || (w && e.contains(t as Node)), [target, wraps] as const, { timeout: 1000 });
}

/**
 * Element the action ran on: the captured one, unless the recorder selector still resolves to it or to an ancestor
 * of it (the recorder may target e.g. the button around a clicked icon). Without a capture, the recorder selector.
 */
async function actionTarget(page: Page, selector: string, captured: ElementHandle | null): Promise<ElementHandle | null> {
  const byRecorder = page.locator(selector);
  const resolved = (await byRecorder.count()) === 1 ? await byRecorder.elementHandle({ timeout: 1000 }) : null;
  if (!captured) return resolved;
  if (resolved && (await resolved.evaluate((r, c) => r === c || r.contains(c), captured))) return resolved;
  await resolved?.dispose();
  return captured;
}

/**
 * Code of a stable locator for the element the recorded action ran on, or null when none was found.
 * Called right after the recorder reported an action whose selector looks fragile; `target` comes from takeActionTarget.
 */
export async function findStableLocator(
  page: Page,
  selector: string,
  opts: { actionName?: string; target?: ElementHandle | null } = {},
): Promise<string | null> {
  if (selector.includes("enter-frame")) return null;
  const chosen = await actionTarget(page, selector, opts.target ?? null);
  if (!chosen) return null;
  let handle = chosen;
  if (opts.target) {
    const shown = (
      await page.evaluateHandle(
        ([el, clicked]) => (window as unknown as { __e2eShown?: (e: Node, c: Node) => Node }).__e2eShown?.(el, clicked) ?? el,
        [chosen, opts.target] as const,
      )
    ).asElement();
    if (shown && !(await shown.evaluate((a, b) => a === b, chosen))) {
      if (chosen !== opts.target) await chosen.dispose().catch(() => undefined);
      handle = shown;
    } else await shown?.dispose();
  }
  try {
    const cfg: CandidateConfig = { utility: UTILITY_CLASS_RE.source, hash: HASH_CLASS_RE.source, state: STATE_CLASS_RE.source, forClick: opts.actionName === "click" };
    const candidates = await handle.evaluate(collectCandidates, cfg);
    for (const c of candidates) {
      if (await findsExactly(page, c, handle).catch(() => false)) return specToCode(c.spec);
    }
    return null;
  } finally {
    if (handle !== opts.target) await handle.dispose().catch(() => undefined);
  }
}
