/**
 * Ruled overlay on draw pages.
 *
 * One map-chrome button cycles three settings:
 *
 *   - **wide** — US wide-ruled (36px screen gap at the camera you wrote at).
 *   - **college** — tighter college-ruled (28px at that same camera).
 *   - **off** — no painted rules.
 *
 * Wide and college are not skins on the same handwriting. Letters written on
 * wide paper are larger; college letters are smaller. The button picks which
 * original ruling the ink was written to (or which of the two it fits), it
 * does not retarget writing onto the other grid.
 *
 * Both pitches are stored in **scene units** from the **same capture zoom**,
 * even when the overlay is off (behind-the-scenes anchors). Resize and reload
 * scale `gap = pitch × zoom`; they never recapture 36px/28px against the
 * current window. Device localStorage only remembers whether rules are painted;
 * the pair lives in the notebook file.
 *
 * When rules are painted, the first line is padded a fraction of **that**
 * ruling so ink sits just above the rule instead of on it.
 */

export type LinedPaperMode = "wide" | "college" | "off";
export type LinedRuling = "wide" | "college";

export interface LinedPitchPair {
  wide: number;
  college: number;
}

export interface LinedPitchState {
  pair: LinedPitchPair | null;
  rule: LinedRuling | null;
}

const KEY = "whiteboard.linedPaper.v1";

export const LINED_PAPER_MODES: readonly LinedPaperMode[] = ["off", "wide", "college"];

/** Original overlay — US wide-ruled, held in screen pixels. */
export const LINED_PAPER_WIDE_SCREEN_PX = 36;

/**
 * College-ruled vs wide-ruled is 9/32" vs 11/32" (9/11).
 * 36 × 9/11 ≈ 29.5; 28 is a clear step down without collapsing into graph paper.
 */
export const LINED_PAPER_COLLEGE_SCREEN_PX = 28;

/**
 * How far above the rule the baseline should rest, as a fraction of that
 * ruling's scene pitch. College's pad is smaller because college's gap is.
 */
export const LINED_PAPER_SIT_ABOVE_FRAC = 0.14;

export function isLinedPaperMode(value: unknown): value is LinedPaperMode {
  return value === "wide" || value === "college" || value === "off";
}

export function isLinedRuling(value: unknown): value is LinedRuling {
  return value === "wide" || value === "college";
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

/** Both rulings from the same write-time zoom. Never mix zooms. */
export function linedPitchPairFromZoom(zoom: number): LinedPitchPair | null {
  const wide = linedPaperScenePitch("wide", zoom);
  const college = linedPaperScenePitch("college", zoom);
  if (!(wide > 0) || !(college > 0)) return null;
  return { wide, college };
}

const COLLEGE_FROM_WIDE = LINED_PAPER_COLLEGE_SCREEN_PX / LINED_PAPER_WIDE_SCREEN_PX;

/** Complete the other ruling from one known source pitch (same capture zoom). */
export function linedPitchPairFromRuling(
  pitch: number,
  ruling: LinedRuling,
): LinedPitchPair | null {
  if (!(pitch > 0) || !Number.isFinite(pitch)) return null;
  if (ruling === "wide") {
    return { wide: pitch, college: pitch * COLLEGE_FROM_WIDE };
  }
  return { college: pitch, wide: pitch / COLLEGE_FROM_WIDE };
}

export function completeLinedPitchPair(partial: {
  wide?: number;
  college?: number;
}): LinedPitchPair | null {
  const wide = asPositive(partial.wide);
  const college = asPositive(partial.college);
  if (wide > 0 && college > 0) return { wide, college };
  if (wide > 0) return linedPitchPairFromRuling(wide, "wide");
  if (college > 0) return linedPitchPairFromRuling(college, "college");
  return null;
}

/**
 * Fill a missing pair from this zoom; never overwrite a pair that already
 * exists. Toggle / resize must go through here so college does not become
 * `28 / currentZoom` under writing that was captured at another camera.
 */
export function ensureLinedPitchPair(
  existing: LinedPitchPair | null,
  zoom: number,
): LinedPitchPair | null {
  const complete = completeLinedPitchPair(existing ?? {});
  if (complete) return complete;
  return linedPitchPairFromZoom(zoom);
}

export function activeLinedPitch(
  pair: LinedPitchPair | null,
  rule: LinedRuling | null,
): number {
  if (!pair) return 0;
  if (rule === "college") return pair.college;
  if (rule === "wide") return pair.wide;
  return pair.wide > 0 ? pair.wide : pair.college;
}

/** CSS px between rules so the overlay scales with the ink. */
export function linedPaperCssGap(scenePitch: number, zoom: number): number {
  if (!(scenePitch > 0) || !(zoom > 0) || !Number.isFinite(zoom)) return 0;
  return scenePitch * zoom;
}

export function linedSitAboveScene(scenePitch: number): number {
  if (!(scenePitch > 0) || !Number.isFinite(scenePitch)) return 0;
  return scenePitch * LINED_PAPER_SIT_ABOVE_FRAC;
}

/**
 * Scene Y of the first painted rule. When `sitAbove` is on, the rule sits
 * slightly below the page-top grid so handwriting rests just above the line.
 */
export function linedFirstRuleScene(
  originY: number,
  scenePitch: number,
  sitAbove: boolean,
): number {
  if (!(scenePitch > 0) || !Number.isFinite(scenePitch)) return originY;
  const pad = sitAbove ? linedSitAboveScene(scenePitch) : 0;
  return originY + scenePitch + pad;
}

function asPositive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function rulingFromUnknown(value: unknown, fallbackMode: LinedPaperMode): LinedRuling | null {
  if (isLinedRuling(value)) return value;
  if (fallbackMode === "wide" || fallbackMode === "college") return fallbackMode;
  return null;
}

/**
 * Both source pitches and the ruling the ink was written to (or picked as
 * the original fit). Older files only saved one pitch and a camera zoom.
 */
export function linedPitchStateFromAppState(
  appState: unknown,
  fallbackMode: LinedPaperMode = "wide",
): LinedPitchState {
  if (!appState || typeof appState !== "object") return { pair: null, rule: null };
  const rec = appState as Record<string, unknown>;
  const rule = rulingFromUnknown(rec.linedRule, fallbackMode);
  const pair =
    completeLinedPitchPair({
      wide: asPositive(rec.linedPitchWide),
      college: asPositive(rec.linedPitchCollege),
    }) ??
    (asPositive(rec.linedPitch) > 0
      ? linedPitchPairFromRuling(asPositive(rec.linedPitch), rule ?? "wide")
      : null);
  return { pair, rule };
}

/**
 * Explicit scene pitch stored on the notebook. A camera zoom alone cannot
 * establish the original ruling; capture it at the first real width-fit.
 */
export function linedPitchFromAppState(
  appState: unknown,
  fallbackMode: LinedPaperMode = "wide",
): number {
  if (!appState || typeof appState !== "object") return 0;
  const rec = appState as Record<string, unknown>;
  const stored = asPositive(rec.linedPitch);
  if (stored > 0) return stored;
  const { pair, rule } = linedPitchStateFromAppState(appState, fallbackMode);
  const active = rule ?? (fallbackMode === "college" ? "college" : "wide");
  return activeLinedPitch(pair, active);
}
