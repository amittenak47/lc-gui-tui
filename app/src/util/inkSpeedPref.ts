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
/** Pace wash toward pencil (0 = width only, 1 = old 0.55 alpha floor). */
const FADE_KEY = "whiteboard.inkSpeedFade";
/** Nib material: 0 = hard felt-tip, 1 = seeded overlapping discs. */
const GRAIN_KEY = "whiteboard.inkGrain";

export const INK_SPEED_MIN = 0;
export const INK_SPEED_MAX = 1;
export const INK_SPEED_DEFAULT = 0;

/** Off: speed ink is the ordinary pen with pace-varying width. Pencil pooling is opt-in. */
export const INK_SPEED_BLOT_BLEND_DEFAULT = 0;
/** Width-only until the writer turns the wash up. */
export const INK_SPEED_FADE_DEFAULT = 0;
/** Off: hard marker disc. Texture is opt-in so old notes stay a felt-tip. */
export const INK_GRAIN_DEFAULT = 0;

function clamp(value: number, fallback = INK_SPEED_DEFAULT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(INK_SPEED_MAX, Math.max(INK_SPEED_MIN, value));
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

/** Fired when Ink Pooling blend is saved so the board can re-read it. */
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

/** Fired when Ink Drying (pace wash) is saved so the board can re-read it. */
export const INK_SPEED_FADE_EVENT = "lc-ink-speed-fade";

export function loadInkGrain(): number {
  try {
    const raw = localStorage.getItem(GRAIN_KEY);
    if (raw == null) return INK_GRAIN_DEFAULT;
    return clamp(Number(raw), INK_GRAIN_DEFAULT);
  } catch {
    return INK_GRAIN_DEFAULT;
  }
}

export function saveInkGrain(value: number): void {
  try {
    localStorage.setItem(GRAIN_KEY, String(clamp(value, INK_GRAIN_DEFAULT)));
  } catch {
    /* private browsing */
  }
}

export function grainFromPercent(percent: number): number {
  return clamp(percent / 100, INK_GRAIN_DEFAULT);
}

export function grainToPercent(value: number): number {
  return Math.round(clamp(value, INK_GRAIN_DEFAULT) * 100);
}

/** Fired when Grain is saved so the board can re-read it. */
export const INK_GRAIN_EVENT = "lc-ink-grain";
