/**
 * Device-local: Ink lab HUD + load bar on the whiteboard.
 * Off by default — it is a readout, not a pen.
 */

const KEY = "whiteboard.inkPerfOverlay";

export const INK_PERF_OVERLAY_EVENT = "lc-ink-perf-overlay";

export function loadInkPerfOverlay(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveInkPerfOverlay(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INK_PERF_OVERLAY_EVENT));
  }
}
