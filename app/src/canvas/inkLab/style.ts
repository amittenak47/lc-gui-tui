/**
 * Wash, pooling, capillary. Not a fluid solver. Never in the nib rAF.
 */

import {
  blotPoolRgb,
  dryWashRgb,
  hasStylusPressure,
  inkBlotRestPoolT,
  inkSlowness,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_SPEED_SPAN,
  STROKE_WIDTH_DEFAULT,
  type ScenePoint,
} from "../rasterInk";

import type { SpineDot } from "./instance";

export const INK_HEX = "#1a1a1a";
export const INK_RGB: [number, number, number] = [26, 26, 26];
export const TIP_GROW = 1.7;
export const LAB_NIB_CSS = 7;
/** Pad wash at a sprint: mix toward paper. Stopped writing stays full. */
const LAB_WASH_FAST = 0.42;

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
  /** When the strength dial runs: lift commit, or reshape while down. */
  smoothingMode?: "lift" | "live";
  /** Lift-time Euler spiral. Never on the live nib. */
  clothoid?: boolean;
  /** Lift-time Laplacian relax. Never on the live nib. */
  capillary?: boolean;
};

export function labWashGain(slow: number): number {
  const s = Math.max(0, Math.min(1, slow));
  return LAB_WASH_FAST + (1 - LAB_WASH_FAST) * s;
}

export function washRgb(vx: number, vy: number, dpr: number): [number, number, number] {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const { r, g, b } = dryWashRgb(INK_HEX, labWashGain(slow));
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
 * Pass `slow` to drive speed-ink without inventing a fake velocity.
 */
export function labNibRadius(
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  size = 1,
  slow?: number,
): number {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const sLow = slow ?? inkSlowness(cssPxPerMs);
  const p = Math.max(0.15, Math.min(1, pressure));
  const s = Math.max(0.45, Math.min(2.8, size));
  return Math.max(
    1.15 * dpr,
    LAB_NIB_CSS * dpr * (0.5 + 0.95 * sLow) * (0.7 + 0.3 * p) * s,
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
  const speed = Math.max(0, Math.min(1, pen.speedInk));
  const fade = Math.max(0, Math.min(1, pen.speedFade));
  const blot = Math.max(0, Math.min(1, pen.speedBlotBlend));
  const widthSlow = INK_SLOWNESS_NEUTRAL + (slow - INK_SLOWNESS_NEUTRAL) * speed;
  const r = labNibRadius(vx, vy, dpr, pAmt, size, widthSlow);
  const gain = 1 + (labWashGain(slow) - 1) * fade;
  let washed = dryWashRgb(pen.color, gain);
  if (blot > 1e-3) {
    const poolT = inkBlotRestPoolT(slow, blot);
    if (poolT > 1e-3) {
      washed = blotPoolRgb(
        `rgb(${washed.r}, ${washed.g}, ${washed.b})`,
        poolT,
      );
    }
  }
  return { r, rgb: [washed.r, washed.g, washed.b], a: 1, slow };
}

export function labPenNibOverlay(pen: InkLabPen): number {
  return Math.max(
    1e-6,
    LAB_NIB_CSS * Math.max(pen.dpr, 1) * labNibSizeFromUiWidth(pen.baseWidth),
  );
}

/** Invert {@link inkSlowness} so a preview strip can replay paced capsules. */
export function labCssSpeedFromSlowness(slow: number): number {
  if (!Number.isFinite(slow) || slow >= 1 - 1e-6) return 0;
  const t = Math.max(-1, Math.min(1, 1 - 2 * Math.max(0, Math.min(1, slow))));
  return INK_SPEED_NEUTRAL_PX_MS * INK_SPEED_SPAN ** t;
}

function densifyPreviewPoints(
  points: readonly ScenePoint[],
  mids = 2,
): ScenePoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: ScenePoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push({ ...a });
    for (let k = 1; k <= mids; k++) {
      const t = k / (mids + 1);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        slowness:
          (a.slowness ?? INK_SLOWNESS_NEUTRAL) +
          ((b.slowness ?? INK_SLOWNESS_NEUTRAL) - (a.slowness ?? INK_SLOWNESS_NEUTRAL)) * t,
      });
    }
  }
  out.push({ ...points[points.length - 1]! });
  return out;
}

/** SDF spine for the preset Preview strip. Same dots the live nib would stamp. */
export function labPreviewSpine(
  pen: InkLabPen,
  points: readonly ScenePoint[],
  dpr: number,
  scaleX = 1,
  scaleY = 1,
): SpineDot[] {
  const dense = densifyPreviewPoints(points);
  const out: SpineDot[] = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i]!;
    const prev = dense[i - 1];
    const next = dense[i + 1];
    const from = prev ?? p;
    const to = prev ? p : (next ?? p);
    const dx = (to.x - from.x) * scaleX;
    const dy = (to.y - from.y) * scaleY;
    const len = Math.hypot(dx, dy);
    const css = labCssSpeedFromSlowness(p.slowness ?? INK_SLOWNESS_NEUTRAL);
    const vx = len > 1e-6 ? (dx / len) * css * 1000 * dpr : 0;
    const vy = len > 1e-6 ? (dy / len) * css * 1000 * dpr : 0;
    const styled = labPenDot(pen, vx, vy, dpr, p.pressure, 0, 0);
    out.push({
      x: p.x * scaleX * dpr,
      y: p.y * scaleY * dpr,
      r: styled.r,
      rgb: styled.rgb,
      a: styled.a,
      p: p.pressure,
      slow: styled.slow,
    });
  }
  return out;
}

/** Toolbar / preset snapshot → live Ink lab pen. Never scales by board zoom. */
export function labPenFromToolbar(opts: {
  color: string;
  uiWidth: number;
  dpr: number;
  pressureClip: number;
  pressureSensitive: boolean;
  blot?: number;
  speed?: number;
  fade?: number;
  smoothing?: number;
  smoothingMode?: "lift" | "live";
  clothoid?: boolean;
  capillary?: boolean;
}): InkLabPen {
  return {
    color: opts.color,
    baseWidth: opts.uiWidth,
    overlayScale: 1,
    dpr: opts.dpr,
    maxFullness: 1,
    pressureClip: opts.pressureClip,
    pressureSensitive: opts.pressureSensitive,
    speedInk: opts.speed ?? 0,
    speedBlotBlend: opts.blot ?? 0,
    speedFade: opts.fade ?? 0,
    boldness: 1,
    smoothing: opts.smoothing,
    smoothingMode: opts.smoothingMode,
    clothoid: opts.clothoid === true,
    capillary: opts.capillary === true,
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
