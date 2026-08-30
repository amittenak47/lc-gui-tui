/**
 * Device-local preference: how much the pen's pace changes what it lays down.
 *
 * Off by default. It is a real change to how handwriting looks, and the right
 * amount is a matter of taste and of how fast the writer's hand actually moves
 * — so it is a dial someone turns up on purpose, not something that arrives
 * with an update and makes their existing notes look different.
 */

const KEY = "whiteboard.inkSpeed";
/** Soft rim + dwell growth feel (0 = hard expanding disc, 1 = soft rim / faster grow). */
const BLOT_BLEND_KEY = "whiteboard.inkSpeedBlotBlend";
/** Travel dry-out along the stroke (0 = full length, 1 = dries quickly). */
const FADE_KEY = "whiteboard.inkSpeedFade";
/** Endpoint tuner for Speed ink (−1 = kill rest blob, +1 = bolder ends). */
const BODY_KEY = "whiteboard.inkSpeedBodyAccent";

export const INK_SPEED_MIN = 0;
export const INK_SPEED_MAX = 1;
export const INK_SPEED_DEFAULT = 0;
export const INK_SPEED_BODY_MIN = -1;
export const INK_SPEED_BODY_MAX = 1;

/** Off: speed ink is the ordinary pen with pace-varying width. Pencil pooling is opt-in. */
export const INK_SPEED_BLOT_BLEND_DEFAULT = 0;
/** Width-only until the writer turns the wash up. */
export const INK_SPEED_FADE_DEFAULT = 0;
/** Off: Speed ink rest-to-sprint only. Negative thins rest blobs; positive fattens them. */
export const INK_SPEED_BODY_ACCENT_DEFAULT = 0;

function clamp(value: number, fallback = INK_SPEED_DEFAULT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(INK_SPEED_MAX, Math.max(INK_SPEED_MIN, value));
}

function clampBody(value: number, fallback = INK_SPEED_BODY_ACCENT_DEFAULT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(INK_SPEED_BODY_MAX, Math.max(INK_SPEED_BODY_MIN, value));
}

/** Stored as 0–1; the UI shows 0–100%. */
export function loadInkSpeed(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return INK_SPEED_DEFAULT;
    return clamp(Number(raw));
  } catch {
    return INK_SPEED_DEFAULT;
  }
}

export function saveInkSpeed(value: number): void {
  try {
    localStorage.setItem(KEY, String(clamp(value)));
  } catch {
    /* private browsing */
  }
}

export function speedInkFromPercent(percent: number): number {
  return clamp(percent / 100);
}

export function speedInkToPercent(value: number): number {
  return Math.round(clamp(value) * 100);
}

/** 0 = hard expanding disc; 1 = wider soft rim + faster dwell growth. */
export function loadInkSpeedBlotBlend(): number {
  try {
    const raw = localStorage.getItem(BLOT_BLEND_KEY);
    if (raw == null) return INK_SPEED_BLOT_BLEND_DEFAULT;
    return clamp(Number(raw), INK_SPEED_BLOT_BLEND_DEFAULT);
  } catch {
    return INK_SPEED_BLOT_BLEND_DEFAULT;
  }
}

export function saveInkSpeedBlotBlend(value: number): void {
  try {
    localStorage.setItem(BLOT_BLEND_KEY, String(clamp(value, INK_SPEED_BLOT_BLEND_DEFAULT)));
  } catch {
    /* private browsing */
  }
}

export function speedBlotBlendFromPercent(percent: number): number {
  return clamp(percent / 100, INK_SPEED_BLOT_BLEND_DEFAULT);
}

export function speedBlotBlendToPercent(value: number): number {
  return Math.round(clamp(value, INK_SPEED_BLOT_BLEND_DEFAULT) * 100);
}

/** Fired when Speed blot blend is saved so the board can re-read it. */
export const INK_SPEED_BLOT_BLEND_EVENT = "lc-ink-speed-blot-blend";

export function loadInkSpeedFade(): number {
  try {
    const raw = localStorage.getItem(FADE_KEY);
    if (raw == null) return INK_SPEED_FADE_DEFAULT;
    return clamp(Number(raw), INK_SPEED_FADE_DEFAULT);
  } catch {
    return INK_SPEED_FADE_DEFAULT;
  }
}

export function saveInkSpeedFade(value: number): void {
  try {
    localStorage.setItem(FADE_KEY, String(clamp(value, INK_SPEED_FADE_DEFAULT)));
  } catch {
    /* private browsing */
  }
}

export function speedFadeFromPercent(percent: number): number {
  return clamp(percent / 100, INK_SPEED_FADE_DEFAULT);
}

export function speedFadeToPercent(value: number): number {
  return Math.round(clamp(value, INK_SPEED_FADE_DEFAULT) * 100);
}

/** Fired when Speed fade is saved so the board can re-read it. */
export const INK_SPEED_FADE_EVENT = "lc-ink-speed-fade";

export function loadInkSpeedBodyAccent(): number {
  try {
    const raw = localStorage.getItem(BODY_KEY);
    if (raw == null) return INK_SPEED_BODY_ACCENT_DEFAULT;
    return clampBody(Number(raw));
  } catch {
    return INK_SPEED_BODY_ACCENT_DEFAULT;
  }
}

export function saveInkSpeedBodyAccent(value: number): void {
  try {
    localStorage.setItem(BODY_KEY, String(clampBody(value)));
  } catch {
    /* private browsing */
  }
}

export function speedBodyAccentFromPercent(percent: number): number {
  return clampBody(percent / 100);
}

export function speedBodyAccentToPercent(value: number): number {
  return Math.round(clampBody(value) * 100);
}

/** Off / +N% / −N% for the bipolar Body slider. */
export function speedBodyAccentLabel(value: number): string {
  const pct = speedBodyAccentToPercent(value);
  if (pct === 0) return "Off";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** Fired when Body accent is saved so the board can re-read it. */
export const INK_SPEED_BODY_ACCENT_EVENT = "lc-ink-speed-body-accent";
