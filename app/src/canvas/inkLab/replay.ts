/**
 * Replay committed pen ops as Ink lab capsules (scene-space radii), not stamps.
 * Highlighter / eraser stay on the 2D stamp path.
 */

import { fillMiterStroke } from "./fallback";
import { labDotWashRgb, labNibRadius } from "./style";
import type { SpineDot } from "./instance";
import {
  dryWashRgb,
  inkLineWidth,
  isHostBoundOp,
  setInkSceneTransform,
  STROKE_WIDTH_DEFAULT,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ViewportTransform,
} from "../rasterInk";

export function isInkLabPenOp(op: InkOp): op is InkDrawOp {
  return op.kind === "draw" && op.highlight !== true && !isHostBoundOp(op);
}

export function splitInkOpsForLabReplay(ops: readonly InkOp[]): {
  lab: InkDrawOp[];
  stamp: InkOp[];
} {
  const lab: InkDrawOp[] = [];
  const stamp: InkOp[] = [];
  for (const op of ops) {
    if (isInkLabPenOp(op)) lab.push(op);
    else stamp.push(op);
  }
  return { lab, stamp };
}

function fallbackSceneRadius(op: InkDrawOp, pressure: number): number {
  const size =
    inkLineWidth(op.baseWidth, 0, false) /
    Math.max(1e-6, inkLineWidth(STROKE_WIDTH_DEFAULT, 0, false));
  return labNibRadius(0, 0, 1, pressure, size);
}

export function labSpineFromDrawOp(op: InkDrawOp): SpineDot[] {
  const fade = op.speedFade ?? 0;
  return op.points.map((p) => {
    const washed =
      p.slowness != null && fade > 1e-6
        ? labDotWashRgb(op.color, p.slowness, fade)
        : dryWashRgb(op.color, 1);
    return {
      x: p.x,
      y: p.y,
      r: p.radius != null && p.radius > 0 ? p.radius : fallbackSceneRadius(op, p.pressure),
      rgb: [washed.r, washed.g, washed.b] as [number, number, number],
      a: 1,
      p: p.pressure,
      slow: p.slowness,
    };
  });
}

/** Inverse of Board's overlay → scene bake. Ink lab replay is overlay pixels. */
export function overlaySpineFromDrawOp(
  op: InkDrawOp,
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
  dpr: number,
): SpineDot[] {
  const k = Math.max(1e-6, viewport.zoom * dpr);
  return labSpineFromDrawOp(op).map((d) => ({
    ...d,
    x: (d.x + viewport.scrollX) * k,
    y: (d.y + viewport.scrollY) * k,
    r: d.r * k,
  }));
}

/** Draw lab pen strokes in the same scene transform as {@link paintRasterInk}. */
export function paintLabDrawOps(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportTransform,
  ops: readonly InkDrawOp[],
  dpr: number,
  clip: SceneBounds | null = null,
): void {
  if (ops.length === 0) return;
  setInkSceneTransform(ctx, viewport, dpr);
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    ctx.clip();
  }
  for (const op of ops) {
    const spine = labSpineFromDrawOp(op);
    if (spine.length === 0) continue;
    const rgb = spine[0]!.rgb ?? [26, 26, 26];
    fillMiterStroke(ctx, spine, null, rgb);
  }
  if (clip) ctx.restore();
}
