/**
 * Device-local preference: boost stroke opacity to compensate for alpha blandness
 * when speed blot blend softens dwell/join discs.
 *
 * 100% = current alpha; 0% = transparent; 300% = 3× alpha (clamped to opaque at paint).
 */

const KEY = "whiteboard.inkBoldness";

export const INK_BOLDNESS_MIN = 0;
export const INK_BOLDNESS_MAX = 3;
export const INK_BOLDNESS_DEFAULT = 1;

function clamp(value: number, fallback = INK_BOLDNESS_DEFAULT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(INK_BOLDNESS_MAX, Math.max(INK_BOLDNESS_MIN, value));
}

/** Stored as 0–3; the UI shows 0–300%. */
export function loadInkBoldness(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return INK_BOLDNESS_DEFAULT;
    return clamp(Number(raw));
  } catch {
    return INK_BOLDNESS_DEFAULT;
  }
}

export function saveInkBoldness(value: number): void {
  try {
    localStorage.setItem(KEY, String(clamp(value)));
  } catch {
    /* private browsing */
  }
}

export function inkBoldnessFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function inkBoldnessToPercent(value: number): number {
  return Math.round(clamp(value) * 100);
}

/** Fired when ink boldness is saved so the board can re-read it. */
export const INK_BOLDNESS_EVENT = "lc-ink-boldness";
