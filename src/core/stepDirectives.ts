/** Lower-case ASCII form: Vietnamese diacritics removed, đ → d. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

const SCREENSHOT_RE = /\bchup\s+(lai\s+)?(man\s*hinh|anh|ket\s*qua|trang|toan)|\bchup\s*(lai\s*)?[.:]?$|screenshot|\bcapture\b/;
const CLOSE_RE = /\b(dong|tat|close|thoat)\b.*\b(trinh duyet|browser|tab|cua so|window)\b/;

export interface StepDirectives {
  /** 1-based numbers of steps that ask for a screenshot. */
  screenshot: number[];
  /** 1-based numbers of steps that ask to close the browser. */
  close: number[];
}

/** Finds manual steps like "Chụp màn hình" / "Đóng browser" that the script must reproduce exactly. */
export function stepDirectives(steps: string[]): StepDirectives {
  const out: StepDirectives = { screenshot: [], close: [] };
  steps.forEach((step, i) => {
    const s = fold(step);
    if (SCREENSHOT_RE.test(s)) out.screenshot.push(i + 1);
    if (CLOSE_RE.test(s)) out.close.push(i + 1);
  });
  return out;
}
