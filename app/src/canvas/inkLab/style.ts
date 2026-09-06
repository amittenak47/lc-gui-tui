/**
 * Wash, pooling, capillary. Not a fluid solver. Never in the nib rAF.
 */

import { dryWashRgb, inkSlowness } from "../rasterInk";

import type { SpineDot } from "./instance";

export const INK_HEX = "#1a1a1a";
export const INK_RGB: [number, number, number] = [26, 26, 26];
export const TIP_GROW = 1.7;

export function washRgb(vx: number, vy: number, dpr: number): [number, number, number] {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const gain = 0.42 + 0.58 * slow;
  const { r, g, b } = dryWashRgb(INK_HEX, gain);
  return [r, g, b];
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
      };
    }
    cur = next;
  }
  return cur;
}
