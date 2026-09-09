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
 * Pitch is stored in **scene units** on the notebook so the rules travel with
 * the ink: a page written on a tablet at one zoom still sits on the lines when
 * the desktop opens it at another. The wide/college numbers are the screen gap
 * used to *capture* that scene pitch (36px / 28px at the camera you wrote at).
 * Device localStorage only remembers whether rules are on; the gap lives in the
 * file.
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

/** Scene units between rules at this screen pitch and camera zoom. */
export function linedPaperScenePitch(mode: LinedPaperMode, zoom: number): number {
  const screen = linedPaperScreenPx(mode);
  if (!(screen > 0) || !(zoom > 0) || !Number.isFinite(zoom)) return 0;
  return screen / zoom;
}

/** CSS px between rules so the overlay scales with the ink. */
export function linedPaperCssGap(scenePitch: number, zoom: number): number {
  if (!(scenePitch > 0) || !(zoom > 0) || !Number.isFinite(zoom)) return 0;
  return scenePitch * zoom;
}

function zoomFromUnknown(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner) && inner > 0) return inner;
  }
  return 0;
}

/**
 * Scene pitch stored on the notebook, or recovered from the camera it was
 * written at (older files only saved zoom; the overlay used to be 36px on
 * whatever screen you opened).
 */
export function linedPitchFromAppState(
  appState: unknown,
  fallbackMode: LinedPaperMode = "wide",
): number {
  if (!appState || typeof appState !== "object") return 0;
  const rec = appState as Record<string, unknown>;
  if (typeof rec.linedPitch === "number" && Number.isFinite(rec.linedPitch) && rec.linedPitch > 0) {
    return rec.linedPitch;
  }
  const zoom = zoomFromUnknown(rec.zoom);
  if (!(zoom > 0)) return 0;
  const mode = fallbackMode === "off" ? "wide" : fallbackMode;
  return linedPaperScenePitch(mode, zoom);
}
