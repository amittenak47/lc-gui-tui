/**
 * Tree and heap.
 *
 * Both take `cells` as a **level-order** array — index 0 is the root, node `i`
 * has children `2i+1` and `2i+2`, and `null` marks a gap. That is the one layout
 * a model can produce reliably without doing geometry, and it is exactly how
 * LeetCode serializes trees, so it needs no translation.
 *
 * Recursion trees often send parent→child `entries` instead (branching factor
 * is not 2). Those use the same forest layout as the call tree.
 *
 * The heap adds the backing array underneath, because the whole point of a heap
 * is that the tree and the array are the same thing.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL,
  CELL_GAP,
  headerOffset,
  arrow,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  layoutForest,
  linkArrow,
  type RenderContext,
} from "../layout";
import { cellText, parentChildEdges } from "../schema";

function nodeMetrics(ctx: RenderContext): { w: number; h: number; fontSize: number; levelH: number } {
  let longest = 1;
  for (const frame of ctx.program.frames) {
    for (const value of frame.cells) {
      if (value === null || value === undefined) continue;
      longest = Math.max(longest, cellText(value).length);
    }
  }
  const w = Math.max(52, Math.min(128, longest * 8 + 22));
  const h = longest > 6 ? 38 : 44;
  const fontSize = longest > 8 ? 13 : longest > 4 ? 14 : 16;
  return { w, h, fontSize, levelH: h + 42 };
}

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
  levelH: number,
): { x: number; y: number } {
  const depth = depthOf(index);
  const slotsAtDepth = 2 ** depth;
  const positionInLevel = index - (slotsAtDepth - 1);
  const slotWidth = width / slotsAtDepth;
  return {
    x: origin.x + slotWidth * (positionInLevel + 0.5),
    y: origin.y + depth * levelH,
  };
}

interface TreeOptions {
  /** Also draw the level-order array beneath the tree. */
  showBackingArray?: boolean;
}

function renderTreeInner(ctx: RenderContext, options: TreeOptions): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const metrics = nodeMetrics(ctx);
  const count = frame.cells.length;
  const edges = parentChildEdges(frame.entries, count);
  const useForest = edges.length > 0 && !options.showBackingArray;

  let centres: Array<{ x: number; y: number } | undefined>;
  if (useForest) {
    centres = layoutForest(count, edges, { x: origin.x, y: top }, {
      node: metrics.w,
      nodeHeight: metrics.h,
      gap: 18,
      levelH: metrics.levelH,
    });
  } else {
    const levels = count > 0 ? depthOf(count - 1) + 1 : 0;
    const width = Math.max(2 ** Math.max(levels - 1, 0) * (metrics.w + CELL_GAP), metrics.w * 4);
    centres = frame.cells.map((value, index) => {
      if (value === null || value === undefined) return undefined;
      return nodeCentre(index, { x: origin.x, y: top }, width, metrics.levelH);
    });
    frame.cells.forEach((value, index) => {
      if (value === null || value === undefined) return;
      for (const child of [2 * index + 1, 2 * index + 2]) {
        const childValue = frame.cells[child];
        if (childValue === null || childValue === undefined) continue;
        const from = centres[index];
        const to = centres[child];
        if (!from || !to) continue;
        out.push(
          arrow(
            ctx,
            `edge-${index}-${child}`,
            { x: from.x, y: from.y + metrics.h / 2 },
            { x: to.x, y: to.y - metrics.h / 2 },
          ),
        );
      }
    });
  }

  if (useForest) {
    edges.forEach(([parent, child], edgeIndex) => {
      const from = centres[parent];
      const to = centres[child];
      if (!from || !to) return;
      out.push(linkArrow(ctx, `edge-${edgeIndex}`, from, to, metrics.h));
    });
  }

  frame.cells.forEach((value, index) => {
    if (value === null || value === undefined) return;
    const centre = centres[index];
    if (!centre) return;
    out.push(
      ...cellBox(
        ctx,
        `node-${index}`,
        centre.x - metrics.w / 2,
        centre.y - metrics.h / 2,
        cellText(value),
        {
          highlighted: isHighlighted(frame, index),
          width: metrics.w,
          height: metrics.h,
          fontSize: metrics.fontSize,
        },
      ),
    );
  });

  let bottom =
    centres.reduce((max, point) => Math.max(max, point ? point.y + metrics.h / 2 : 0), top) + 8;

  if (options.showBackingArray && count > 0) {
    out.push(caption(ctx, "arraylabel", origin.x, bottom + 4, "backing array"));
    const arrayTop = bottom + 24;
    frame.cells.forEach((value, index) => {
      const x = origin.x + index * (CELL + CELL_GAP);
      out.push(
        ...cellBox(ctx, `arr-${index}`, x, arrayTop, cellText(value), {
          highlighted: isHighlighted(frame, index),
          height: 34,
        }),
      );
      out.push(caption(ctx, `arridx-${index}`, x + 4, arrayTop + 40, String(index)));
    });
    bottom = arrayTop + 58;
  }

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty tree)"));
    bottom = top + 24;
  }
  return [...out, ...footer(ctx, bottom)];
}

export function renderTree(ctx: RenderContext): Skeleton[] {
  return renderTreeInner(ctx, {});
}

export function renderHeap(ctx: RenderContext): Skeleton[] {
  return renderTreeInner(ctx, { showBackingArray: true });
}
