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
 */

export type ChromeWakeMarker = "smear" | "pulse" | "off";

const KEY = "whiteboard.chromeWake.v1";

export const CHROME_WAKE_MARKERS: readonly ChromeWakeMarker[] = ["smear", "pulse", "off"];

export const CHROME_WAKE_DEFAULT: ChromeWakeMarker = "smear";

/** Fired on the window when Settings saves, so an open board picks it up. */
export const CHROME_WAKE_EVENT = "lc-chrome-wake";

export function isChromeWakeMarker(value: unknown): value is ChromeWakeMarker {
  return value === "smear" || value === "pulse" || value === "off";
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
