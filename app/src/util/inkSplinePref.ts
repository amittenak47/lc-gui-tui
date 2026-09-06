/**
 * Experimental spline-outline pen. Device-local, off by default.
 *
 * Spline outline: perfect-freehand interpolation + one filled polygon.
 * Spline gradient: dry-ink wash as a bitmap between the two rails.
 */

const OUTLINE_KEY = "whiteboard.inkSplineOutline";
const GRADIENT_KEY = "whiteboard.inkSplineGradient";

export const INK_SPLINE_OUTLINE_DEFAULT = false;
export const INK_SPLINE_GRADIENT_DEFAULT = false;
export const INK_SPLINE_OUTLINE_EVENT = "lc-ink-spline-outline";
export const INK_SPLINE_GRADIENT_EVENT = "lc-ink-spline-gradient";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private browsing */
  }
}

export function loadInkSplineOutline(): boolean {
  return readFlag(OUTLINE_KEY, INK_SPLINE_OUTLINE_DEFAULT);
}

export function saveInkSplineOutline(value: boolean): void {
  writeFlag(OUTLINE_KEY, value);
}

export function loadInkSplineGradient(): boolean {
  return readFlag(GRADIENT_KEY, INK_SPLINE_GRADIENT_DEFAULT);
}

export function saveInkSplineGradient(value: boolean): void {
  writeFlag(GRADIENT_KEY, value);
}
