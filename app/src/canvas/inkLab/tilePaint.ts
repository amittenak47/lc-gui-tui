import {
  applyInkOp,
  HIGHLIGHT_WIDTH_SCALE,
  INK_SPEED_WIDTH_RANGE,
  INK_TIP_STEP,
  inkLineWidth,
  isHostBoundOp,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
} from "../rasterInk";
import { isInkLabPenOp, labSpineFromDrawOp } from "./replay";
import { paintSdfSpines } from "./sdfPaint";
import { noteInkTileRaster } from "../inkTileMetrics";
import { TILE_OVERLAP_PX, TILE_PX, inkTileCanvasPx, levelScale, tileSceneSize } from "../inkTileGrid";

export type InkTilePaintJob = {
  ops: readonly InkOp[];
  clip: SceneBounds | null;
  level: number;
  tx: number;
  ty: number;
  tilePx?: number;
};

export type InkTilePaintResult = {
  sdfMs: number;
};

function paintBounds(op: InkOp): SceneBounds {
  const pad =
    op.kind === "erase"
      ? op.radius
      : (op.highlight
          ? inkLineWidth(op.baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE
          : inkLineWidth(
              op.baseWidth,
              1,
              op.pressureSensitive,
              1,
              op.speedInk ?? 0,
            ) *
            (1 + INK_SPEED_WIDTH_RANGE * (op.speedBlotBlend ?? 0))) /
          2 +
        INK_TIP_STEP;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of op.points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return minX === Infinity
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    : { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function tileBounds(level: number, tx: number, ty: number, tilePx: number): SceneBounds {
  const size = tileSceneSize(level, tilePx);
  return {
    minX: tx * size,
    minY: ty * size,
    maxX: (tx + 1) * size,
    maxY: (ty + 1) * size,
  };
}

function paddedTileBounds(bounds: SceneBounds, scale: number): SceneBounds {
  const pad = TILE_OVERLAP_PX / scale;
  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  };
}

function setTileTransform(
  ctx: CanvasRenderingContext2D,
  bounds: SceneBounds,
  scale: number,
): void {
  ctx.setTransform(
    scale,
    0,
    0,
    scale,
    TILE_OVERLAP_PX - bounds.minX * scale,
    TILE_OVERLAP_PX - bounds.minY * scale,
  );
}

function boundsOverlap(a: SceneBounds, b: SceneBounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function intersectBounds(a: SceneBounds, b: SceneBounds): SceneBounds | null {
  const box = {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
  if (box.minX >= box.maxX || box.minY >= box.maxY) return null;
  return box;
}

function boundedDrawRuns(op: InkDrawOp, bounds: SceneBounds): InkDrawOp[] {
  const points = op.points;
  if (points.length <= 256) return [op];
  const runs: InkDrawOp[] = [];
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    const from = Math.max(0, runStart - 1);
    const to = Math.min(points.length, end + 1);
    runs.push({ ...op, points: points.slice(from, to) });
    runStart = -1;
  };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const reach = Math.max(
      2,
      op.baseWidth * (op.highlight ? HIGHLIGHT_WIDTH_SCALE : 1),
      a.radius ?? 0,
      b.radius ?? 0,
    );
    const hits =
      Math.max(a.x, b.x) + reach >= bounds.minX &&
      Math.min(a.x, b.x) - reach <= bounds.maxX &&
      Math.max(a.y, b.y) + reach >= bounds.minY &&
      Math.min(a.y, b.y) - reach <= bounds.maxY;
    if (hits) {
      if (runStart < 0) runStart = i - 1;
    } else {
      flush(i);
    }
  }
  flush(points.length);
  return runs;
}

function paintBoundedOp(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  bounds: SceneBounds,
  scale: number,
): void {
  const points = op.points;
  if (points.length <= 256) {
    applyInkOp(ctx, op, scale);
    return;
  }
  if (op.kind === "erase") {
    const r = Math.max(0, op.radius);
    const local = points.filter(
      (p) =>
        p.x + r >= bounds.minX &&
        p.x - r <= bounds.maxX &&
        p.y - r <= bounds.maxY &&
        p.y + r >= bounds.minY,
    );
    if (local.length > 0) applyInkOp(ctx, { ...op, points: local }, scale);
    return;
  }
  for (const run of boundedDrawRuns(op, bounds)) applyInkOp(ctx, run, scale);
}

/**
 * Raster one scene tile into `ctx`. Shared by the UI cache and the worker.
 * Records {@link noteInkTileRaster} so loading can split tile walk vs SDF.
 */
export function paintInkTile(
  ctx: CanvasRenderingContext2D,
  job: InkTilePaintJob,
  boundsOf: (op: InkOp) => SceneBounds = paintBounds,
): InkTilePaintResult {
  const started = performance.now();
  const tilePx = job.tilePx ?? TILE_PX;
  const canvasPx = tilePx + 2 * TILE_OVERLAP_PX;
  const bounds = tileBounds(job.level, job.tx, job.ty, tilePx);
  const scale = levelScale(job.level);
  const padded = paddedTileBounds(bounds, scale);
  const paintable = job.clip ? intersectBounds(bounds, job.clip) : bounds;
  let sdfMs = 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasPx, canvasPx);
  if (!paintable) {
    noteInkTileRaster(performance.now() - started, 0);
    return { sdfMs: 0 };
  }

  setTileTransform(ctx, bounds, scale);
  if (job.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      job.clip.minX,
      job.clip.minY,
      job.clip.maxX - job.clip.minX,
      job.clip.maxY - job.clip.minY,
    );
    ctx.clip();
  }

  let labRuns: InkDrawOp[] = [];
  const flushLab = () => {
    if (labRuns.length === 0) return;
    const spines = labRuns.map(labSpineFromDrawOp);
    const sdf0 = performance.now();
    if (!paintSdfSpines(ctx, spines)) {
      for (const run of labRuns) applyInkOp(ctx, run, scale);
    }
    sdfMs += performance.now() - sdf0;
    labRuns = [];
  };
  for (const op of job.ops) {
    if (isHostBoundOp(op)) continue;
    if (!boundsOverlap(boundsOf(op), padded)) continue;
    if (isInkLabPenOp(op)) {
      labRuns.push(...boundedDrawRuns(op, padded));
      continue;
    }
    flushLab();
    paintBoundedOp(ctx, op, padded, scale);
  }
  flushLab();
  if (job.clip) ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  noteInkTileRaster(performance.now() - started, sdfMs);
  return { sdfMs };
}

export { inkTileCanvasPx };
