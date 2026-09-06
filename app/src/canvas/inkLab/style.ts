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
  inkStrokeStyle,
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
 * Live radius + wash from the same formulas the committed InkOp paint uses.
 */
export function labPenDot(
  pen: InkLabPen,
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  consumed: number,
  growT: number,
): { r: number; rgb: [number, number, number]; a: number; slow: number } {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const style = inkStrokeStyle(
    pen.baseWidth,
    pen.maxFullness,
    pressure,
    pen.pressureClip,
    pen.pressureSensitive,
    consumed,
    slow,
    pen.speedInk,
    false,
    pen.boldness,
    pen.speedFade,
  );
  const pAmt =
    pen.pressureSensitive && hasStylusPressure(pressure)
      ? Math.max(0, Math.min(1, pressure))
      : 1;
  const widthGain = inkPoolingWidthGain(growT, pen.speedBlotBlend, pAmt);
  const r = Math.max(0.5, (style.lineWidth * pen.overlayScale * widthGain) / 2);
  const poolT =
    growT > 1e-6 ? blotRichnessT(growT, pen.speedBlotBlend, slow, pAmt) : 0;
  const washed = dryWashRgb(pen.color, style.dryGain ?? 1);
  return { r, rgb: rgbTuple(washed, poolT), a: style.alpha, slow };
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
