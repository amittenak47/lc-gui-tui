/**
 * Tree and heap.
 *
 * Both take `cells` as a **level-order** array — index 0 is the root, node `i`
 * has children `2i+1` and `2i+2`, and `null` marks a gap. That is the one layout
 * a model can produce reliably without doing geometry, and it is exactly how
 * LeetCode serializes trees, so it needs no translation.
 *
 * The heap adds the backing array underneath, because the whole point of a heap
 * is that the tree and the array are the same thing.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL,
  CELL_GAP,
  HEADER_H,
  arrow,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  type RenderContext,
} from "../layout";
import { cellText } from "../schema";

const NODE = 44;
const LEVEL_H = 78;

/** Depth of a level-order index: 0, 1..2, 3..6, ... */
function depthOf(index: number): number {
  return Math.floor(Math.log2(index + 1));
}

/**
 * Centre of a node, spread so each level fills the same width — the classic
 * "complete binary tree" layout, which stays readable to about 4 levels.
 */
function nodeCentre(
  index: number,
  origin: { x: number; y: number },
  width: number,
): { x: number; y: number } {
  const depth = depthOf(index);
  const slotsAtDepth = 2 ** depth;
  const positionInLevel = index - (slotsAtDepth - 1);
  const slotWidth = width / slotsAtDepth;
  return {
    x: origin.x + slotWidth * (positionInLevel + 0.5),
    y: origin.y + depth * LEVEL_H,
  };
}

interface TreeOptions {
  /** Also draw the level-order array beneath the tree. */
  showBackingArray?: boolean;
}

function renderTreeInner(ctx: RenderContext, options: TreeOptions): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H;
  const levels = frame.cells.length > 0 ? depthOf(frame.cells.length - 1) + 1 : 0;
  const width = Math.max(2 ** Math.max(levels - 1, 0) * (NODE + CELL_GAP), NODE * 4);

  // Edges first, so nodes paint over the arrow ends.
  frame.cells.forEach((value, index) => {
    if (value === null || value === undefined) return;
    for (const child of [2 * index + 1, 2 * index + 2]) {
      const childValue = frame.cells[child];
      if (childValue === null || childValue === undefined) continue;
      const from = nodeCentre(index, { x: origin.x, y: top }, width);
      const to = nodeCentre(child, { x: origin.x, y: top }, width);
      out.push(
        arrow(
          ctx,
          `edge-${index}-${child}`,
          { x: from.x, y: from.y + NODE / 2 },
          { x: to.x, y: to.y - NODE / 2 },
        ),
      );
    }
  });

  frame.cells.forEach((value, index) => {
    if (value === null || value === undefined) return;
    const centre = nodeCentre(index, { x: origin.x, y: top }, width);
    out.push(
      cellBox(
        ctx,
        `node-${index}`,
        centre.x - NODE / 2,
        centre.y - NODE / 2,
        cellText(value),
        { highlighted: isHighlighted(frame, index), width: NODE, height: NODE },
      ),
    );
  });

  let bottom = top + Math.max(levels, 1) * LEVEL_H;

  if (options.showBackingArray && frame.cells.length > 0) {
    out.push(caption(ctx, "arraylabel", origin.x, bottom + 4, "backing array"));
    const arrayTop = bottom + 24;
    frame.cells.forEach((value, index) => {
      const x = origin.x + index * (CELL + CELL_GAP);
      out.push(
        cellBox(ctx, `arr-${index}`, x, arrayTop, cellText(value), {
          highlighted: isHighlighted(frame, index),
          height: 34,
        }),
      );
      out.push(caption(ctx, `arridx-${index}`, x + 4, arrayTop + 40, String(index)));
    });
    bottom = arrayTop + 58;
  }

  if (frame.cells.length === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty tree)"));
  }
  return [...out, ...footer(ctx, bottom)];
}

export function renderTree(ctx: RenderContext): Skeleton[] {
  return renderTreeInner(ctx, {});
}

export function renderHeap(ctx: RenderContext): Skeleton[] {
  return renderTreeInner(ctx, { showBackingArray: true });
}
