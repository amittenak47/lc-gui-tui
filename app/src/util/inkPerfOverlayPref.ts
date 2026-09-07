/**
 * Device-local: Ink lab HUD and load bar on the whiteboard, independently.
 * Off by default — they are readouts, not a pen.
 */

const OVERLAY_KEY = "whiteboard.inkPerfOverlay";
const BAR_KEY = "whiteboard.inkPerfBar";

export const INK_PERF_OVERLAY_EVENT = "lc-ink-perf-overlay";

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INK_PERF_OVERLAY_EVENT));
  }
}

export function loadInkPerfOverlay(): boolean {
  try {
    return localStorage.getItem(OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveInkPerfOverlay(on: boolean): void {
  try {
    localStorage.setItem(OVERLAY_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
  emit();
}

/**
 * Load bar. Missing key follows the overlay so a device that already had the
 * combined toggle on keeps the bar until Settings splits them.
 */
export function loadInkPerfBar(): boolean {
  try {
    const raw = localStorage.getItem(BAR_KEY);
    if (raw == null) return loadInkPerfOverlay();
    return raw === "1";
  } catch {
    return false;
  }
}

export function saveInkPerfBar(on: boolean): void {
  try {
    localStorage.setItem(BAR_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
  emit();
}
