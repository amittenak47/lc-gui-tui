/**
 * Bounded live-stroke raster state.
 *
 * The logical InkOp keeps every point. This object only bounds the geometry
 * reprocessed for its preview: settled geometry is painted once into `stable`,
 * while `working` is rebuilt from that bitmap plus a short mutable tail.
 */

import type { InkDrawOp, ScenePoint } from "./rasterInk";

/** Tip history kept mutable so joins, pace filtering and pooling may settle. */
export const LIVE_STROKE_TAIL_NIBS = 32;
/** Promote in useful chunks instead of touching the stable bitmap every frame. */
export const LIVE_STROKE_PROMOTE_NIBS = 16;

export type LiveStrokeComposite = "source-over" | "multiply";

export interface LiveStrokeMaskPaint {
  /** Opacity applied once when the complete mask is put over committed ink. */
  alpha: number;
  composite: LiveStrokeComposite;
}

export interface LiveStrokeFrame {
  canvas: HTMLCanvasElement;
  alpha: number;
  composite: LiveStrokeComposite;
  /** Oldest point still repainted each frame. */
  tailStart: number;
}

export type LiveStrokeRangePainter = (
  ctx: CanvasRenderingContext2D,
  fromIndex: number,
  toIndex: number,
  capHead: boolean,
  capEnd: boolean,
) => LiveStrokeMaskPaint;

function travelBetween(points: readonly ScenePoint[], from: number, to: number): number {
  let total = 0;
  const first = Math.max(1, from + 1);
  const last = Math.min(to, points.length - 1);
  for (let i = first; i <= last; i += 1) {
    total += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
  }
  return total;
}

/**
 * First point in the mutable tail. Walking from the tip makes the work depend
 * on distance on paper, not on stylus report rate.
 */
export function liveStrokeTailStart(
  points: readonly ScenePoint[],
  nib: number,
  tailNibs = LIVE_STROKE_TAIL_NIBS,
): number {
  if (points.length < 3) return 0;
  const keep = Math.max(nib, 1e-6) * Math.max(1, tailNibs);
  let travelled = 0;
  for (let i = points.length - 1; i > 0; i -= 1) {
    travelled += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
    if (travelled >= keep) return i - 1;
  }
  return 0;
}

export function shouldPromoteLiveStroke(
  points: readonly ScenePoint[],
  nib: number,
  bakedThrough: number,
  candidate: number,
  promoteNibs = LIVE_STROKE_PROMOTE_NIBS,
): boolean {
  if (candidate <= bakedThrough) return false;
  if (bakedThrough === 0) return true;
  return travelBetween(points, bakedThrough, candidate) >= Math.max(nib, 1e-6) * promoteNibs;
}

type CanvasFactory = () => HTMLCanvasElement;

export class LiveStrokeSurface {
  private stable: HTMLCanvasElement | null = null;
  private working: HTMLCanvasElement | null = null;
  private pointsIdentity: readonly ScenePoint[] | null = null;
  private bakedThrough = 0;
  private active = false;
  private alpha = 0;
  private composite: LiveStrokeComposite = "source-over";

  constructor(
    private readonly createCanvas: CanvasFactory = () => document.createElement("canvas"),
  ) {}

  reset(): void {
    this.pointsIdentity = null;
    this.bakedThrough = 0;
    this.active = false;
    this.alpha = 0;
    this.composite = "source-over";
    this.clear(this.stable);
    this.clear(this.working);
  }

  get settledPointCount(): number {
    return this.bakedThrough;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Return null while the stroke still fits in the mutable window. The caller
   * uses the exact legacy full painter for those ordinary short strokes.
   */
  paint(
    op: InkDrawOp,
    nib: number,
    width: number,
    height: number,
    painter: LiveStrokeRangePainter,
  ): LiveStrokeFrame | null {
    if (width < 1 || height < 1 || op.points.length === 0) return null;

    // Straightening and any other reshape replace the array. Previously baked
    // pixels then describe a different path and must not survive.
    if (this.pointsIdentity !== op.points || this.bakedThrough >= op.points.length) {
      this.reset();
      this.pointsIdentity = op.points;
    }

    const candidate = liveStrokeTailStart(op.points, nib);
    if (!this.active && candidate === 0) return null;

    const stable = this.ensure("stable", width, height);
    const working = this.ensure("working", width, height);
    if (!stable || !working) return null;
    const stableCtx = stable.getContext("2d");
    const workCtx = working.getContext("2d");
    if (!stableCtx || !workCtx) return null;

    if (
      candidate > this.bakedThrough &&
      shouldPromoteLiveStroke(op.points, nib, this.bakedThrough, candidate)
    ) {
      const result = painter(
        stableCtx,
        this.bakedThrough,
        candidate,
        this.bakedThrough === 0,
        false,
      );
      this.absorb(result);
      this.bakedThrough = candidate;
      this.active = true;
    }

    if (!this.active) return null;

    workCtx.setTransform(1, 0, 0, 1, 0, 0);
    workCtx.globalAlpha = 1;
    workCtx.globalCompositeOperation = "source-over";
    workCtx.clearRect(0, 0, working.width, working.height);
    workCtx.drawImage(stable, 0, 0);

    const last = op.points.length - 1;
    if (last > this.bakedThrough) {
      const result = painter(
        workCtx,
        this.bakedThrough,
        last,
        this.bakedThrough === 0,
        true,
      );
      this.absorb(result);
    }
    workCtx.setTransform(1, 0, 0, 1, 0, 0);
    workCtx.globalAlpha = 1;
    workCtx.globalCompositeOperation = "source-over";

    return {
      canvas: working,
      alpha: Math.max(0, Math.min(1, this.alpha > 0 ? this.alpha : 1)),
      composite: this.composite,
      tailStart: this.bakedThrough,
    };
  }

  private absorb(result: LiveStrokeMaskPaint): void {
    if (Number.isFinite(result.alpha)) this.alpha = Math.max(this.alpha, result.alpha);
    this.composite = result.composite;
  }

  private ensure(
    which: "stable" | "working",
    width: number,
    height: number,
  ): HTMLCanvasElement | null {
    let canvas = which === "stable" ? this.stable : this.working;
    if (!canvas) {
      canvas = this.createCanvas();
      if (which === "stable") this.stable = canvas;
      else this.working = canvas;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      // A resize clears the backing store. Both surfaces must restart together.
      if (this.active || this.bakedThrough > 0) {
        this.bakedThrough = 0;
        this.active = false;
        this.alpha = 0;
        const other = which === "stable" ? this.working : this.stable;
        this.clear(other);
      }
    }
    return canvas;
  }

  private clear(canvas: HTMLCanvasElement | null): void {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
