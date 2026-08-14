/**
 * Ruled overlay on draw pages.
 *
 * One map-chrome button cycles three settings, because "lined or not" was not
 * enough once people wanted notebook pitch as well as legal-pad pitch:
 *
 *   - **wide** — the original 36px screen gap (US wide-ruled ratio).
 *   - **college** — a tighter 28px gap (college-ruled vs wide ≈ 9/11).
 *   - **off** — no rules.
 *
 * Pitch is in CSS pixels, not scene units, so a fitted wide draw frame cannot
 * shrink the gap into an unwritable grid. Persisted on the device: it is a way
 * of working, not a per-page mark.
 */

export type LinedPaperMode = "wide" | "college" | "off";

const KEY = "whiteboard.linedPaper.v1";

export const LINED_PAPER_MODES: readonly LinedPaperMode[] = ["off", "wide", "college"];

/** Original overlay — US wide-ruled, held in screen pixels. */
export const LINED_PAPER_WIDE_SCREEN_PX = 36;

/**
 * College-ruled vs wide-ruled is 9/32" vs 11/32" (9/11).
 * 36 × 9/11 ≈ 29.5; 28 is a clear step down without collapsing into graph paper.
 */
export const LINED_PAPER_COLLEGE_SCREEN_PX = 28;

export function isLinedPaperMode(value: unknown): value is LinedPaperMode {
  return value === "wide" || value === "college" || value === "off";
}

export function loadLinedPaperMode(): LinedPaperMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isLinedPaperMode(raw) ? raw : "off";
  } catch {
    return "off";
  }
}

export function saveLinedPaperMode(mode: LinedPaperMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private browsing */
  }
}

/** off → wide → college → off. First tap from the default still turns rules on. */
export function nextLinedPaperMode(mode: LinedPaperMode): LinedPaperMode {
  const index = LINED_PAPER_MODES.indexOf(mode);
  return LINED_PAPER_MODES[(index + 1) % LINED_PAPER_MODES.length];
}

export function linedPaperScreenPx(mode: LinedPaperMode): number {
  if (mode === "wide") return LINED_PAPER_WIDE_SCREEN_PX;
  if (mode === "college") return LINED_PAPER_COLLEGE_SCREEN_PX;
  return 0;
}

export function linedPaperLabel(mode: LinedPaperMode): string {
  switch (mode) {
    case "wide":
      return "Wide lined paper";
    case "college":
      return "College lined paper";
    default:
      return "No lined paper";
  }
}
