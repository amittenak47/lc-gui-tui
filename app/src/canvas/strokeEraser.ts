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

import { inkLineWidth, type InkDrawOp, type InkEraseOp, type InkOp } from "./rasterInk";

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
