/**
 * Wash, pooling, capillary. Not a fluid solver. Never in the nib rAF.
 */

import {
  blotPoolRgb,
  blotRichnessT,
  dryWashRgb,
  hasStylusPressure,
  inkLineWidth,
  inkPoolingWidthGain,
  inkSlowness,
} from "../rasterInk";

import type { SpineDot } from "./instance";

export const INK_HEX = "#1a1a1a";
export const INK_RGB: [number, number, number] = [26, 26, 26];
export const TIP_GROW = 1.7;

/** Toolbar pen, mapped into overlay device pixels. */
export type InkLabPen = {
  color: string;
  /** Scene-space baseWidth already converted with inkBaseWidthForZoom. */
  baseWidth: number;
  /** Overlay device pixels per scene unit (zoom * dpr). */
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

function rgbTuple(
  washed: { r: number; g: number; b: number },
  poolT: number,
): [number, number, number] {
  if (poolT < 1e-3) return [washed.r, washed.g, washed.b];
  const pooled = blotPoolRgb(
    `rgb(${washed.r}, ${washed.g}, ${washed.b})`,
    poolT,
  );
  return [pooled.r, pooled.g, pooled.b];
}

/**
 * Live radius matching the Ink lab pad: continuous capsules, not speed-ink
 * beads. Toolbar size sets the base; pace and pressure taper it the same way
 * `nibRadius` does on the comparison pad. Coverage stays opaque so overlapping
 * cones do not read as a stamp chain.
 */
export function labPenDot(
  pen: InkLabPen,
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  _consumed: number,
  growT: number,
): { r: number; rgb: [number, number, number]; a: number; slow: number } {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const pAmt =
    pen.pressureSensitive && hasStylusPressure(pressure)
      ? Math.max(0.15, Math.min(1, pressure))
      : 0.5;
  const baseR = Math.max(
    1.15 * dpr,
    (inkLineWidth(pen.baseWidth, 0, false) * pen.overlayScale) / 2,
  );
  const widthGain = inkPoolingWidthGain(growT, 0, pAmt);
  const r = Math.max(
    1.15 * dpr,
    baseR * (0.5 + 0.95 * slow) * (0.7 + 0.3 * pAmt) * widthGain,
  );
  const poolT = growT > 1e-6 ? blotRichnessT(growT, 0, slow, pAmt) : 0;
  const washed = dryWashRgb(pen.color, 1);
  return { r, rgb: rgbTuple(washed, poolT), a: 1, slow };
}

export function labPenNibOverlay(pen: InkLabPen): number {
  return Math.max(1e-6, inkLineWidth(pen.baseWidth, 0, false) * pen.overlayScale);
}

export function growTipRadius(base: number, current: number): number {
  const cap = base * TIP_GROW;
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
