/**
 * Wash, pooling, capillary. Not a fluid solver. Never in the nib rAF.
 */

import {
  dryWashRgb,
  hasStylusPressure,
  inkSlowness,
  STROKE_WIDTH_DEFAULT,
} from "../rasterInk";

import type { SpineDot } from "./instance";

export const INK_HEX = "#1a1a1a";
export const INK_RGB: [number, number, number] = [26, 26, 26];
export const TIP_GROW = 1.7;
/** Same CSS nib the comparison pad uses. Never scaled by camera zoom. */
export const LAB_NIB_CSS = 7;

/** Toolbar pen. Radius is the Ink lab nib, not a zoom-scaled stamp. */
export type InkLabPen = {
  color: string;
  /** Toolbar nib width (UI units). Not `inkBaseWidthForZoom`. */
  baseWidth: number;
  /**
   * Unused for radius. Kept so older `setPen` call sites still type-check.
   * Pass 1.
   */
  overlayScale: number;
  /** Device pixels per CSS pixel of the overlay. */
  dpr: number;
  maxFullness: number;
  pressureClip: number;
  pressureSensitive: boolean;
  speedInk: number;
  speedBlotBlend: number;
  speedFade: number;
  boldness: number;
  /** Lift-bake Chaikin strength. Absent means the board default. */
  smoothing?: number;
};

export function washRgb(vx: number, vy: number, dpr: number): [number, number, number] {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const gain = 0.42 + 0.58 * slow;
  const { r, g, b } = dryWashRgb(INK_HEX, gain);
  return [r, g, b];
}

/**
 * Slider units → pad size. Default width is size 1 (Ink lab nib).
 * Not stamp `inkLineWidth`.
 */
export function labNibSizeFromUiWidth(uiWidth: number): number {
  const w = Number.isFinite(uiWidth) && uiWidth > 0 ? uiWidth : STROKE_WIDTH_DEFAULT;
  return Math.max(0.45, Math.min(2.8, w / STROKE_WIDTH_DEFAULT));
}

export function labPressureAmt(pen: InkLabPen, pressure: number): number {
  if (!pen.pressureSensitive || !hasStylusPressure(pressure)) return 0.5;
  const clip = Math.max(0.15, Math.min(1, pen.pressureClip || 1));
  return Math.max(0.15, Math.min(1, pressure / clip));
}

/**
 * Ink lab pad nib. Radius stays above the sample gate so capsules overlap
 * instead of leaving a dotted stamp trail. `size` is toolbar width vs default.
 */
export function labNibRadius(
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  size = 1,
): number {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const p = Math.max(0.15, Math.min(1, pressure));
  const s = Math.max(0.45, Math.min(2.8, size));
  return Math.max(
    1.15 * dpr,
    LAB_NIB_CSS * dpr * (0.5 + 0.95 * slow) * (0.7 + 0.3 * p) * s,
  );
}

export function labPenDot(
  pen: InkLabPen,
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  _consumed: number,
  _growT: number,
): { r: number; rgb: [number, number, number]; a: number; slow: number } {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const pAmt = labPressureAmt(pen, pressure);
  const size = labNibSizeFromUiWidth(pen.baseWidth);
  const r = labNibRadius(vx, vy, dpr, pAmt, size);
  const washed = dryWashRgb(pen.color, 1);
  return { r, rgb: [washed.r, washed.g, washed.b], a: 1, slow };
}

export function labPenNibOverlay(pen: InkLabPen): number {
  return Math.max(
    1e-6,
    LAB_NIB_CSS * Math.max(pen.dpr, 1) * labNibSizeFromUiWidth(pen.baseWidth),
  );
}

/** Toolbar / preset snapshot → live Ink lab pen. Never scales by board zoom. */
export function labPenFromToolbar(opts: {
  color: string;
  uiWidth: number;
  dpr: number;
  pressureClip: number;
  pressureSensitive: boolean;
  blot?: number;
  smoothing?: number;
}): InkLabPen {
  return {
    color: opts.color,
    baseWidth: opts.uiWidth,
    overlayScale: 1,
    dpr: opts.dpr,
    maxFullness: 1,
    pressureClip: opts.pressureClip,
    pressureSensitive: opts.pressureSensitive,
    speedInk: 0,
    speedBlotBlend: opts.blot ?? 0,
    speedFade: 0,
    boldness: 1,
    smoothing: opts.smoothing,
  };
}

export function growTipRadius(base: number, current: number): number {
  const cap = base * TIP_GROW;
  return Math.min(cap, current + (cap - base) * 0.05);
}

/** Hold-grow knob: 0 stays nib-sized, 1 is the pad's {@link TIP_GROW}. */
export function labHoldGrow(base: number, current: number, blot: number): number {
  const t = Math.max(0, Math.min(1, blot));
  if (t < 1e-3) return base;
  const cap = base * (1 + (TIP_GROW - 1) * t);
  return Math.min(cap, current + (cap - base) * 0.05);
}

export function capillaryRelax(points: readonly SpineDot[], sweeps = 6): SpineDot[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  let cur = points.map((p) => ({ ...p }));
  for (let s = 0; s < sweeps; s++) {
    const next = cur.map((p) => ({ ...p }));
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1]!;
      const b = cur[i]!;
      const c = cur[i + 1]!;
      next[i] = {
        x: (a.x + 2 * b.x + c.x) / 4,
        y: (a.y + 2 * b.y + c.y) / 4,
        r: (a.r + b.r + c.r) / 3,
        rgb: b.rgb,
        a: b.a,
        p: b.p,
        slow: b.slow,
      };
    }
    cur = next;
  }
  return cur;
}
