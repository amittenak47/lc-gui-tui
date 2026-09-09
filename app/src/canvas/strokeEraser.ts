/**
 * Whole-stroke erasing, as an alternative to rubbing pixels out.
 *
 * The eraser is a bitmap one: it paints `destination-out` discs, so at a small
 * radius it takes a bite out of the *side* of a letter and leaves the rest. That
 * is a real eraser's behaviour and it is genuinely useful — you can thin a
 * stroke, open a gap, tidy a join — which is why it stays the default.
 *
 * It is also occasionally the wrong tool. Removing one wrong line out of a
 * diagram with a pixel eraser means tracing the line; every writer who has done
 * that has wanted the other kind, where touching a stroke anywhere takes the
 * whole thing. So it is a setting, and this module is the half of it that has
 * nothing to do with canvases: given the ops on the page and the rub the writer
 * just made, which strokes did they touch?
 *
 * Pure, and its own module, because the answer is a question about geometry and
 * the alternative is another branch inside the pointer path.
 */

import { inkLineWidth, type InkDrawOp, type InkEraseOp, type InkOp, type ScenePoint } from "./rasterInk";

/** Squared distance from `p` to segment `a`–`b`. */
function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ox = px - ax;
    const oy = py - ay;
    return ox * ox + oy * oy;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const ox = px - (ax + t * dx);
  const oy = py - (ay + t * dy);
  return ox * ox + oy * oy;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(points: readonly { x: number; y: number }[], pad: number): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Does this rub touch this stroke?
 *
 * "Touch" is measured to the ink, not to the centreline — a fat nib is wider
 * than the points it was stamped along, and an eraser held against the visible
 * edge of a thick stroke has plainly touched it.
 */
export function eraseTouchesStroke(op: InkDrawOp, erase: InkEraseOp): boolean {
  const points = op.points;
  const rub = erase.points;
  if (points.length === 0 || rub.length === 0) return false;

  const reach = erase.radius + inkLineWidth(op.baseWidth, 0, false) / 2;
  const strokeBox = boxOf(points, reach);
  const rubBox = boxOf(rub, 0);
  if (!strokeBox || !rubBox || !overlaps(strokeBox, rubBox)) return false;

  const reachSq = reach * reach;
  // A single-point stroke is a dot: there is no segment, so test the point.
  if (points.length === 1) {
    const only = points[0];
    for (const at of rub) {
      const dx = at.x - only.x;
      const dy = at.y - only.y;
      if (dx * dx + dy * dy <= reachSq) return true;
    }
    return false;
  }

  for (const at of rub) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (distanceToSegmentSq(at.x, at.y, a.x, a.y, b.x, b.y) <= reachSq) return true;
    }
  }
  return false;
}

/**
 * The page after a whole-stroke rub, or `null` when it touched nothing.
 *
 * `null` rather than an equal copy so the caller can leave the undo stack alone
 * — an eraser waved over blank paper is not an edit, and pushing a snapshot for
 * it means the writer's next undo does nothing visible.
 *
 * Earlier erase ops are kept exactly where they are. They are part of how the
 * page got to look the way it does, and dropping one because a later rub
 * crossed it would bring back ink the writer had already taken off.
 */
export function opsAfterStrokeErase(
  ops: readonly InkOp[],
  erase: InkEraseOp,
): InkOp[] | null {
  let hit = false;
  const kept = ops.filter((op) => {
    if (op.kind !== "draw") return true;
    if (!eraseTouchesStroke(op, erase)) return true;
    hit = true;
    return false;
  });
  return hit ? kept : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pointAt(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
  const out: ScenePoint = {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    pressure: lerp(a.pressure, b.pressure, t),
  };
  if (a.slowness != null || b.slowness != null) {
    out.slowness = lerp(a.slowness ?? 0, b.slowness ?? 0, t);
  }
  if (a.radius != null || b.radius != null) {
    out.radius = lerp(a.radius ?? 0, b.radius ?? 0, t);
  }
  return out;
}

function nearlySame(a: ScenePoint, b: ScenePoint, epsilon = 0.02): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

function segmentCircleHits(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [];
  const fx = ax - cx;
  const fy = ay - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * len2 * c;
  if (disc < 0) return [];
  const sqrtDisc = Math.sqrt(disc);
  const hits: number[] = [];
  for (const sign of [-1, 1] as const) {
    const t = (-b + sign * sqrtDisc) / (2 * len2);
    if (t >= 0 && t <= 1) hits.push(t);
  }
  hits.sort((left, right) => left - right);
  return hits;
}

function clipSegmentOutside(
  a: ScenePoint,
  b: ScenePoint,
  cx: number,
  cy: number,
  r: number,
): Array<[ScenePoint, ScenePoint]> {
  const hits = segmentCircleHits(a.x, a.y, b.x, b.y, cx, cy, r);
  const ts = [0, ...hits, 1].filter(
    (value, index, list) => index === 0 || value - list[index - 1]! > 1e-6,
  );
  const r2 = r * r;
  const outside: Array<[ScenePoint, ScenePoint]> = [];
  for (let index = 0; index < ts.length - 1; index++) {
    const t0 = ts[index]!;
    const t1 = ts[index + 1]!;
    const mid = pointAt(a, b, (t0 + t1) / 2);
    const ox = mid.x - cx;
    const oy = mid.y - cy;
    if (ox * ox + oy * oy > r2) outside.push([pointAt(a, b, t0), pointAt(a, b, t1)]);
  }
  return outside;
}

function eraseReach(op: InkDrawOp, erase: InkEraseOp): number {
  return erase.radius + inkLineWidth(op.baseWidth, 0, false) / 2;
}

function pointInsideRub(point: ScenePoint, erase: InkEraseOp, reach: number): boolean {
  const reachSq = reach * reach;
  for (const at of erase.points) {
    const dx = point.x - at.x;
    const dy = point.y - at.y;
    if (dx * dx + dy * dy <= reachSq) return true;
  }
  return false;
}

/**
 * Pieces of `op` that lie outside the rub, or `null` when the rub missed.
 *
 * Empty array means the stroke was taken entirely.
 */
export function clipDrawOpOutsideErase(op: InkDrawOp, erase: InkEraseOp): InkDrawOp[] | null {
  if (!eraseTouchesStroke(op, erase)) return null;
  const reach = eraseReach(op, erase);
  const points = op.points;
  if (points.length === 0) return [];
  if (points.length === 1) return pointInsideRub(points[0]!, erase, reach) ? [] : [op];

  let segs: Array<[ScenePoint, ScenePoint]> = [];
  for (let i = 1; i < points.length; i++) segs.push([points[i - 1]!, points[i]!]);
  for (const at of erase.points) {
    segs = segs.flatMap(([a, b]) => clipSegmentOutside(a, b, at.x, at.y, reach));
  }

  const runs: ScenePoint[][] = [];
  for (const [a, b] of segs) {
    const last = runs[runs.length - 1];
    if (last && nearlySame(last[last.length - 1]!, a)) last.push(b);
    else runs.push([a, b]);
  }

  return runs
    .filter((run) => run.length >= 2)
    .map((run) => {
      const { id: _id, ...rest } = op;
      void _id;
      return { ...rest, points: run };
    });
}

/**
 * Pixel-eraser: cut the rubbed discs out of draw ops. `null` when nothing
 * was hit, so a miss is not an undo step.
 *
 * Dest-out on the live snap is only a preview. Lab pen strokes live in the
 * overlay and are replayed from these ops — if the draw stays whole, the
 * mark comes back on remesh, save, and sync.
 */
export function opsAfterPartialErase(
  ops: readonly InkOp[],
  erase: InkEraseOp,
): InkOp[] | null {
  let hit = false;
  const kept: InkOp[] = [];
  for (const op of ops) {
    if (op.kind !== "draw") {
      kept.push(op);
      continue;
    }
    const pieces = clipDrawOpOutsideErase(op, erase);
    if (!pieces) {
      kept.push(op);
      continue;
    }
    hit = true;
    kept.push(...pieces);
  }
  return hit ? kept : null;
}

/**
 * Apply every erase op to the draws that precede it, then drop the erases.
 *
 * Older files stored dest-out erases next to whole overlay pens. Replay has
 * to bake them or the overlay puts the ink back on top of the hole.
 */
export function opsWithErasesBaked(ops: readonly InkOp[]): InkOp[] {
  let out: InkOp[] = [];
  for (const op of ops) {
    if (op.kind === "erase") {
      out = opsAfterPartialErase(out, op) ?? out;
      continue;
    }
    out.push(op);
  }
  return out;
}
