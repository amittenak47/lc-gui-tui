/**
 * How the hidden-controls wake target looks when the eye itself is off screen.
 *
 * Fade/hidden chrome still needs a tap target in that corner. The old mark was
 * a blurred ghost of the eye — a grey-black smear that can sit on a drawing.
 * Three settings, saved on this device:
 *
 *   - **smear** — the current blurred ghost.
 *   - **pulse** — the same checkerboard pixel crawl as the tool-wheel confirm,
 *     so the spot is findable without a grey blob on the page.
 *   - **off** — no mark. The hit target is still there; you tap that corner.
 *
 * **Tint** is a second choice that recolors both smear and pulse: mono (the
 * grey / black-and-white marks) or a ROYGBIV rainbow crawl.
 */

export type ChromeWakeMarker = "smear" | "pulse" | "off";

export type ChromeWakeTint = "mono" | "color";

const KEY = "whiteboard.chromeWake.v1";
const TINT_KEY = "whiteboard.chromeWakeTint.v1";

export const CHROME_WAKE_MARKERS: readonly ChromeWakeMarker[] = ["smear", "pulse", "off"];

export const CHROME_WAKE_TINTS: readonly ChromeWakeTint[] = ["mono", "color"];

export const CHROME_WAKE_DEFAULT: ChromeWakeMarker = "smear";

export const CHROME_WAKE_TINT_DEFAULT: ChromeWakeTint = "mono";

/** Fired on the window when Settings saves, so an open board picks it up. */
export const CHROME_WAKE_EVENT = "lc-chrome-wake";

export function isChromeWakeMarker(value: unknown): value is ChromeWakeMarker {
  return value === "smear" || value === "pulse" || value === "off";
}

export function isChromeWakeTint(value: unknown): value is ChromeWakeTint {
  return value === "mono" || value === "color";
}

export function loadChromeWakeMarker(): ChromeWakeMarker {
  try {
    const raw = localStorage.getItem(KEY);
    return isChromeWakeMarker(raw) ? raw : CHROME_WAKE_DEFAULT;
  } catch {
    return CHROME_WAKE_DEFAULT;
  }
}

export function saveChromeWakeMarker(marker: ChromeWakeMarker): void {
  try {
    localStorage.setItem(KEY, marker);
  } catch {
    /* private browsing */
  }
}

export function loadChromeWakeTint(): ChromeWakeTint {
  try {
    const raw = localStorage.getItem(TINT_KEY);
    return isChromeWakeTint(raw) ? raw : CHROME_WAKE_TINT_DEFAULT;
  } catch {
    return CHROME_WAKE_TINT_DEFAULT;
  }
}

export function saveChromeWakeTint(tint: ChromeWakeTint): void {
  try {
    localStorage.setItem(TINT_KEY, tint);
  } catch {
    /* private browsing */
  }
}

export function chromeWakeMarkerLabel(marker: ChromeWakeMarker): string {
  switch (marker) {
    case "smear":
      return "Grey smear";
    case "pulse":
      return "Checkerboard pulse";
    default:
      return "Hidden";
  }
}

export function chromeWakeTintLabel(tint: ChromeWakeTint): string {
  return tint === "color" ? "Rainbow pulse" : "Black and white";
}
