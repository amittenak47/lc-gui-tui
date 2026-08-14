/** Device-local preference: how much stylus pressure counts as "full" press. */

const KEY = "whiteboard.inkPressureClip";

export const PRESSURE_CLIP_MIN = 0.3;
export const PRESSURE_CLIP_MAX = 1;
export const PRESSURE_CLIP_DEFAULT = 1;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return PRESSURE_CLIP_DEFAULT;
  return Math.min(PRESSURE_CLIP_MAX, Math.max(PRESSURE_CLIP_MIN, value));
}

/** Stored as 0.3–1.0; UI shows 30–100%. */
export function loadInkPressureClip(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return PRESSURE_CLIP_DEFAULT;
    const parsed = Number(raw);
    return clamp(parsed);
  } catch {
    return PRESSURE_CLIP_DEFAULT;
  }
}

export function saveInkPressureClip(value: number): void {
  try {
    localStorage.setItem(KEY, String(clamp(value)));
  } catch {
    /* ignore */
  }
}

/** UI percent (30–100) ↔ stored fraction. */
export function pressureClipFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function pressureClipToPercent(clip: number): number {
  return Math.round(clamp(clip) * 100);
}
