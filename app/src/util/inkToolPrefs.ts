/**
 * Global pen / eraser tool prefs — stroke sizes and pressure, shared across
 * problems and scratchpads.
 */

import {
  ERASER_WIDTH_MAX,
  STROKE_WIDTH_DEFAULT,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
} from "../canvas/rasterInk";

const KEY = "lc.inkToolPrefs.v1";

export interface InkToolPrefs {
  penWidth: number;
  eraserWidth: number;
  pressureSensitive: boolean;
  /** Last ink colour — validated against the current theme's swatches on load. */
  inkColor: string | null;
}

const DEFAULTS: InkToolPrefs = {
  penWidth: STROKE_WIDTH_DEFAULT,
  eraserWidth: STROKE_WIDTH_DEFAULT,
  pressureSensitive: true,
  inkColor: null,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function loadInkToolPrefs(): InkToolPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<InkToolPrefs>;
    return {
      penWidth: clamp(
        typeof parsed.penWidth === "number" ? parsed.penWidth : DEFAULTS.penWidth,
        STROKE_WIDTH_MIN,
        STROKE_WIDTH_MAX,
      ),
      eraserWidth: clamp(
        typeof parsed.eraserWidth === "number" ? parsed.eraserWidth : DEFAULTS.eraserWidth,
        STROKE_WIDTH_MIN,
        ERASER_WIDTH_MAX,
      ),
      pressureSensitive:
        typeof parsed.pressureSensitive === "boolean"
          ? parsed.pressureSensitive
          : DEFAULTS.pressureSensitive,
      inkColor: typeof parsed.inkColor === "string" ? parsed.inkColor : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveInkToolPrefs(prefs: InkToolPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private browsing */
  }
}
