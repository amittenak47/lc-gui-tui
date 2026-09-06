/**
 * Experimental live pen: perfect-freehand outline, then one fill.
 *
 * Left and right rails are offsets of the smoothed spine. Caps join them into
 * a closed polygon. Canvas fills that once. That is the tldraw model, not the
 * Speed Ink ribbon.
 */

import { getStroke, getStrokePoints } from "perfect-freehand";

export const SPLINE_THINNING = 0.6;
export const SPLINE_SMOOTHING = 0.5;
export const SPLINE_STREAMLINE = 0.5;
const STRIP_W = 256;
const STRIP_H = 4;

export interface SplineSample {
  x: number;
  y: number;
  pressure: number;
}

export interface SplineStrokeOptions {
  size: number;
  thinning: number;
  last: boolean;
  simulatePressure: boolean;
}

export function splineStrokeOptions(
  size: number,
  thinning: number,
  last: boolean,
  simulatePressure: boolean,
): SplineStrokeOptions {
  return {
    size: Math.max(0.5, size),
    thinning,
    last,
    simulatePressure,
  };
}

function pfOptions(opts: SplineStrokeOptions) {
  return {
    size: opts.size,
    thinning: opts.thinning,
    smoothing: SPLINE_SMOOTHING,
    streamline: SPLINE_STREAMLINE,
    simulatePressure: opts.simulatePressure,
    last: opts.last,
  };
}

export function splineInput(samples: readonly SplineSample[]): number[][] {
  const out: number[][] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    out[i] = [p.x, p.y, p.pressure];
  }
  return out;
}

export function splineOutline(
  samples: readonly SplineSample[],
  opts: SplineStrokeOptions,
): number[][] {
  if (samples.length === 0 || opts.size <= 0) return [];
  return getStroke(splineInput(samples), pfOptions(opts));
}

export function fillSplineOutline(
  ctx: CanvasRenderingContext2D,
  outline: number[][],
): void {
  if (outline.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(outline[0]![0]!, outline[0]![1]!);
  for (let i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i]![0]!, outline[i]![1]!);
  }
  ctx.closePath();
  ctx.fill();
}

export interface SplineRail {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  u: number;
}

/**
 * Left/right rails from the same smoothed spine getStroke uses.
 *
 * Radius is the PF formula: size * (0.5 - thinning * (0.5 - pressure)).
 */
export function splineRails(
  samples: readonly SplineSample[],
  opts: SplineStrokeOptions,
): SplineRail[] {
  if (samples.length === 0 || opts.size <= 0) return [];
  const pts = getStrokePoints(splineInput(samples), pfOptions(opts));
  if (pts.length === 0) return [];
  const total = pts[pts.length - 1]!.runningLength;
  const rails: SplineRail[] = [];
  const thinning = opts.thinning;
  const size = opts.size;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const radius = Math.max(
      0.05,
      size * (0.5 - thinning * (0.5 - p.pressure)),
    );
    const vx = p.vector[0]!;
    const vy = p.vector[1]!;
    const px = -vy * radius;
    const py = vx * radius;
    rails.push({
      lx: p.point[0]! - px,
      ly: p.point[1]! - py,
      rx: p.point[0]! + px,
      ry: p.point[1]! + py,
      u: total > 1e-6 ? p.runningLength / total : 0,
    });
  }
  return rails;
}

export type WashRgb = { r: number; g: number; b: number };

/** 256×4 bitmap, colour along X. Null when this host has no canvas. */
export function washGradientStrip(colors: readonly WashRgb[]): HTMLCanvasElement | null {
  if (typeof document === "undefined" || colors.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = STRIP_W;
  canvas.height = STRIP_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(STRIP_W, STRIP_H);
  const n = colors.length;
  for (let x = 0; x < STRIP_W; x++) {
    const src = colors[Math.min(n - 1, Math.floor((x / (STRIP_W - 1)) * (n - 1)))]!;
    const r = Math.round(src.r);
    const g = Math.round(src.g);
    const b = Math.round(src.b);
    for (let y = 0; y < STRIP_H; y++) {
      const i = (y * STRIP_W + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Stretch a 1D wash bitmap across each rail quad.
 *
 * Affine map of a rectangle onto a parallelogram. Variable width is two
 * triangles, so a sharp width jump can seam. That is the experimental look.
 */
export function fillSplineGradient(
  ctx: CanvasRenderingContext2D,
  rails: readonly SplineRail[],
  strip: HTMLCanvasElement,
): void {
  if (rails.length < 2) return;
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  for (let i = 0; i < rails.length - 1; i++) {
    const a = rails[i]!;
    const b = rails[i + 1]!;
    const u0 = a.u * STRIP_W;
    const u1 = Math.max(u0 + 1, b.u * STRIP_W);
    drawTexturedTri(
      ctx,
      strip,
      u0,
      0,
      u1,
      0,
      u0,
      STRIP_H,
      a.lx,
      a.ly,
      b.lx,
      b.ly,
      a.rx,
      a.ry,
    );
    drawTexturedTri(
      ctx,
      strip,
      u1,
      0,
      u1,
      STRIP_H,
      u0,
      STRIP_H,
      b.lx,
      b.ly,
      b.rx,
      b.ry,
      a.rx,
      a.ry,
    );
  }
  ctx.imageSmoothingEnabled = prevSmooth;
}

function drawTexturedTri(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number,
): void {
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-8) return;
  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const c = (sx0 * (dx1 - dx2) + sx1 * (dx2 - dx0) + sx2 * (dx0 - dx1)) / denom;
  const d = (sx0 * (dy1 - dy2) + sx1 * (dy2 - dy0) + sx2 * (dy0 - dy1)) / denom;
  const e =
    (sx0 * (sy1 * dx2 - sy2 * dx1) + sx1 * (sy2 * dx0 - sy0 * dx2) + sx2 * (sy0 * dx1 - sy1 * dx0)) /
    denom;
  const f =
    (sx0 * (sy1 * dy2 - sy2 * dy1) + sx1 * (sy2 * dy0 - sy0 * dy2) + sx2 * (sy0 * dy1 - sy1 * dy0)) /
    denom;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
