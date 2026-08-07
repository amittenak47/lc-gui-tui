/**
 * Move pen ink with the page it was written on.
 *
 * Excalidraw elements survive a re-stack on their own: every template element
 * stores `lcRegionOx`/`lcRegionOy` relative to its frame, so `syncRegionLayout`
 * can put a page anywhere and its contents follow. Raster ink cannot do that —
 * an {@link InkOp} is a list of absolute scene points with no frame to hang off,
 * because it is painted to a tile cache rather than kept as scene objects.
 *
 * So when a page moves, its ink has to be carried across by hand. A page moves
 * whenever anything above it changes height: the statement reflowing to a longer
 * problem, the code frame sizing to a longer solution, a draw page growing
 * another half-page under the pen — and, once, when the gap between pages
 * changed and every page below the first shifted down with it.
 *
 * Membership uses the same rule as paging (`regionOfElement`), measured against
 * the frames as they were *before* the move, so a stroke goes wherever the
 * student would say they drew it.
 */

import { regionFramesOf, type LayoutElement } from "../templates/regionLayout";
import { regionOfElement, type PageableElement } from "./pageView";
import type { InkOp } from "./rasterInk";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Frame rectangles keyed by region, in the shape `regionOfElement` wants. */
function rectsOf(elements: readonly LayoutElement[]): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const [region, frame] of regionFramesOf(elements)) {
    rects.set(region, {
      x: num(frame.x, 0),
      y: num(frame.y, 0),
      w: num(frame.width, 0),
      h: num(frame.height, 0),
    });
  }
  return rects;
}

/** Bounding box of one op, as a stand-in element for the membership test. */
function opAsElement(op: InkOp, index: number): PageableElement | null {
  if (op.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of op.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    id: `ink-${index}`,
    type: "freedraw",
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function shifted<T extends InkOp>(op: T, dy: number): T {
  return { ...op, points: op.points.map((p) => ({ ...p, y: p.y + dy })) };
}

/**
 * Carry `ops` across a re-stack, given the element list before and after it.
 *
 * Returns the input array untouched when no page moved, so the common case
 * costs one comparison per frame and no allocation.
 */
export function reanchorInkOps<T extends InkOp>(
  before: readonly LayoutElement[],
  after: readonly LayoutElement[],
  ops: readonly T[],
): readonly T[] {
  if (ops.length === 0) return ops;

  const oldFrames = regionFramesOf(before);
  const newFrames = regionFramesOf(after);

  const shifts = new Map<string, number>();
  for (const [region, oldFrame] of oldFrames) {
    const next = newFrames.get(region);
    if (!next) continue;
    const dy = num(next.y, 0) - num(oldFrame.y, 0);
    if (dy !== 0) shifts.set(region, dy);
  }
  if (shifts.size === 0) return ops;

  const rects = rectsOf(before);
  let moved = false;
  const out = ops.map((op, index) => {
    const probe = opAsElement(op, index);
    if (!probe) return op;
    const region = regionOfElement(probe, rects);
    const dy = region ? shifts.get(region) : undefined;
    if (!dy) return op;
    moved = true;
    return shifted(op, dy);
  });
  return moved ? out : ops;
}
