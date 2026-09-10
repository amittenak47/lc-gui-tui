/**
 * Segment tree: interval nodes `{lo, hi, val}` in heap order (`2i+1` children).
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL_GAP,
  headerOffset,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  linkArrow,
  type RenderContext,
} from "../layout";
import { intervalNode } from "../schema";

const NODE = 56;
const LEVEL_H = 84;

function depthOf(index: number): number {
  return Math.floor(Math.log2(index + 1));
}

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

export function renderSegTree(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const count = frame.cells.length;
  const levels = count > 0 ? depthOf(count - 1) + 1 : 0;
  const width = Math.max(2 ** Math.max(levels - 1, 0) * (NODE + CELL_GAP), NODE * 4);
  const originTop = { x: origin.x, y: top + NODE / 2 + 18 };

  frame.cells.forEach((value, index) => {
    if (!intervalNode(value)) return;
    for (const child of [2 * index + 1, 2 * index + 2]) {
      if (!intervalNode(frame.cells[child])) continue;
      out.push(
        linkArrow(
          ctx,
          `edge-${index}-${child}`,
          nodeCentre(index, originTop, width),
          nodeCentre(child, originTop, width),
          NODE,
        ),
      );
    }
  });

  frame.cells.forEach((value, index) => {
    const node = intervalNode(value);
    if (!node) return;
    const centre = nodeCentre(index, originTop, width);
    out.push(
      ...cellBox(ctx, `node-${index}`, centre.x - NODE / 2, centre.y - NODE / 2, node.val, {
        highlighted: isHighlighted(frame, index),
        width: NODE,
        height: NODE,
      }),
    );
    out.push(
      caption(
        ctx,
        `range-${index}`,
        centre.x - NODE / 2,
        centre.y - NODE / 2 - 16,
        `[${node.lo},${node.hi}]`,
      ),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty segtree)"));
  }
  return [...out, ...footer(ctx, top + Math.max(levels, 1) * LEVEL_H)];
}
