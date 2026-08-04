/** Device-local preference: how hard to smooth a stroke when the pen lifts. */

import { INK_SMOOTHING_DEFAULT } from "../canvas/inkSmoothing";

const KEY = "lc.inkSmoothing";

export const INK_SMOOTHING_MIN = 0;
export const INK_SMOOTHING_MAX = 1;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return INK_SMOOTHING_DEFAULT;
  return Math.min(INK_SMOOTHING_MAX, Math.max(INK_SMOOTHING_MIN, value));
}

/** Stored as 0–1; the UI shows 0–100%. */
export function loadInkSmoothing(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return INK_SMOOTHING_DEFAULT;
    return clamp(Number(raw));
  } catch {
    return INK_SMOOTHING_DEFAULT;
  }
}

export function saveInkSmoothing(value: number): void {
  try {
    localStorage.setItem(KEY, String(clamp(value)));
  } catch {
    /* private browsing */
  }
}

export function smoothingFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function smoothingToPercent(value: number): number {
  return Math.round(clamp(value) * 100);
}

export { INK_SMOOTHING_DEFAULT };
