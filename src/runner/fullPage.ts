import type { Page } from "playwright";

/** Chrome cannot capture much taller screenshots in one piece. */
const MAX_HEIGHT = 16_000;

/**
 * Runs in the page. Content hidden in the main inner scroll area (app shells: fixed sidebar + `height: 100vh` layout
 * with `overflow: auto` content), which `fullPage` cannot see because the document itself does not scroll.
 * Small scrollers (dropdowns, menus, sidebars, fixed-height tables) are ignored.
 */
function hiddenInnerHeight(min: { width: number; height: number }): number {
  let extra = 0;
  for (const el of document.querySelectorAll("body *")) {
    const hidden = el.scrollHeight - el.clientHeight;
    if (hidden <= 1) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < min.width || r.height < min.height) continue;
    extra = Math.max(extra, hidden);
  }
  return extra;
}

/**
 * Runs in the page. A modal (dialog over a backdrop) is centred in the viewport: growing the viewport or capturing the
 * whole page would leave it small in the middle of a tall image, so it is captured as the user sees it.
 * Small non-modal dialogs (date pickers, popovers) do not count.
 */
function openModal(): boolean {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return null;
    const s = getComputedStyle(el);
    return s.visibility === "hidden" || Number(s.opacity) === 0 ? null : r;
  };
  for (const el of document.querySelectorAll('[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]')) {
    const r = shown(el);
    if (!r) continue;
    let modal = el.getAttribute("aria-modal") === "true";
    try {
      modal ||= el.matches("dialog:modal");
    } catch {
      // :modal unsupported
    }
    if (modal || r.width * r.height >= vw * vh * 0.15) return true;
  }
  // Libraries without dialog roles still dim the page with a fixed, semi-transparent backdrop over the whole viewport.
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed") continue;
    const r = shown(el);
    if (!r || r.width < vw * 0.95 || r.height < vh * 0.95) continue;
    const rgba = s.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(/[\s,/]+/).filter(Boolean) ?? [];
    const alpha = s.backgroundColor === "transparent" ? 0 : rgba.length > 3 ? Number(rgba[3]) : 1;
    if ((alpha > 0.05 && alpha < 0.98) || (s.backdropFilter && s.backdropFilter !== "none")) return true;
  }
  return false;
}

export const hasOpenModal = (page: Page) => page.evaluate(openModal).catch(() => false);

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Makes the viewport tall enough to show the whole inner scroll area, runs `shoot`, then restores the viewport.
 * Growth that does not reduce the hidden height (a fixed-height scroller) is undone, so no blank space is captured.
 */
export async function withFullHeight<T>(page: Page, shoot: () => Promise<T>): Promise<T> {
  const original = page.viewportSize();
  if (!original) return shoot();
  let height = original.height;
  const min = { width: original.width * 0.4, height: original.height * 0.5 };
  const hidden = () => page.evaluate(hiddenInnerHeight, min).catch(() => 0);
  try {
    let extra = await hidden();
    for (let i = 0; i < 3 && extra > 1 && height < MAX_HEIGHT; i++) {
      const previous = height;
      height = Math.min(MAX_HEIGHT, height + extra);
      await page.setViewportSize({ width: original.width, height });
      await page.evaluate(nextFrame).catch(() => undefined);
      const left = await hidden();
      if (left >= extra - 1) {
        height = previous;
        await page.setViewportSize({ width: original.width, height });
        break;
      }
      extra = left;
    }
    return await shoot();
  } finally {
    if (height !== original.height) await page.setViewportSize(original).catch(() => undefined);
  }
}
