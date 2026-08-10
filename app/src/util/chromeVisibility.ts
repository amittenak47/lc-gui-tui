/**
 * How much of the board's own furniture is on screen.
 *
 * Hiding the controls used to be one boolean, and it left the eye behind —
 * which is the right answer for finding them again and the wrong one for
 * reading a page, because the thing you asked to get out of the way left a
 * button sitting over the text. Three settings instead, cycled by tapping that
 * same eye:
 *
 *   - **visible** — everything stays put.
 *   - **fade** — everything is there, and goes quiet a few seconds after you
 *     stop using it. The eye goes with it. Touching the corner brings it back.
 *   - **hidden** — nothing, not even the eye. Touching the corner brings the
 *     eye back on its own, so the controls are one more tap away rather than
 *     permanently on screen.
 *
 * Persisted, because it is a way of working rather than a per-page choice.
 */

export type ChromeMode = "visible" | "fade" | "hidden";

const KEY = "lc.chromeMode.v1";

export const CHROME_MODES: readonly ChromeMode[] = ["visible", "fade", "hidden"];

/**
 * How long the chrome waits before going quiet, and how long a corner tap
 * keeps it up.
 *
 * Long enough to pick a pen and change your mind about it; short enough that a
 * page you settled down to read is clear by the time you have found your line.
 */
export const CHROME_IDLE_MS = 4000;

export function isChromeMode(value: unknown): value is ChromeMode {
  return value === "visible" || value === "fade" || value === "hidden";
}

export function loadChromeMode(): ChromeMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isChromeMode(raw) ? raw : "visible";
  } catch {
    return "visible";
  }
}

export function saveChromeMode(mode: ChromeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private browsing */
  }
}

/** The next mode when the eye is tapped — visible → fade → hidden → visible. */
export function nextChromeMode(mode: ChromeMode): ChromeMode {
  const index = CHROME_MODES.indexOf(mode);
  return CHROME_MODES[(index + 1) % CHROME_MODES.length];
}

/** What each mode is called where the reader can see it. */
export function chromeModeLabel(mode: ChromeMode): string {
  switch (mode) {
    case "visible":
      return "Controls stay on screen";
    case "fade":
      return "Controls fade when idle";
    default:
      return "Controls hidden — tap the corner";
  }
}

export interface ChromeVisibility {
  /** The toolbar, theme chip and lined-paper toggle. */
  chrome: boolean;
  /** The eye itself, which outlives the rest in `hidden`. */
  eye: boolean;
}

/**
 * What is on screen, given the mode and whether the corner was touched
 * recently.
 *
 * `awake` is meaningless in `visible` and is what the other two turn on.
 */
export function chromeVisibility(mode: ChromeMode, awake: boolean): ChromeVisibility {
  if (mode === "visible") return { chrome: true, eye: true };
  if (mode === "fade") return { chrome: awake, eye: awake };
  return { chrome: false, eye: awake };
}
