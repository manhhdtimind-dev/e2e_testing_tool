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
