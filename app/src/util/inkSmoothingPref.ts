/** Device-local preference: how hard to smooth a stroke, and when to do it. */

import {
  INK_SMOOTHING_DEFAULT,
  INK_SMOOTHING_MODE_DEFAULT,
  type InkSmoothingMode,
} from "../canvas/inkSmoothing";

const KEY = "whiteboard.inkSmoothing";
const MODE_KEY = "whiteboard.inkSmoothingMode";
const CLOTHOID_KEY = "whiteboard.inkClothoid";
const CAPILLARY_KEY = "whiteboard.inkCapillary";

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

export function loadInkSmoothingMode(): InkSmoothingMode {
  try {
    return localStorage.getItem(MODE_KEY) === "live" ? "live" : INK_SMOOTHING_MODE_DEFAULT;
  } catch {
    return INK_SMOOTHING_MODE_DEFAULT;
  }
}

export function saveInkSmoothingMode(mode: InkSmoothingMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private browsing */
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}

/** Lift-time Euler spiral. Off until turned on in pen settings. */
export function loadInkClothoid(): boolean {
  return loadFlag(CLOTHOID_KEY);
}

export function saveInkClothoid(on: boolean): void {
  saveFlag(CLOTHOID_KEY, on);
}

/** Lift-time Laplacian relax. Off until turned on in pen settings. */
export function loadInkCapillary(): boolean {
  return loadFlag(CAPILLARY_KEY);
}

export function saveInkCapillary(on: boolean): void {
  saveFlag(CAPILLARY_KEY, on);
}

export { INK_SMOOTHING_DEFAULT, INK_SMOOTHING_MODE_DEFAULT, type InkSmoothingMode };
