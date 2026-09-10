/**
 * Recursion / call tree: frames `{fn, args}` with parent→child call edges.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  headerOffset,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  layoutForest,
  linkArrow,
  type RenderContext,
} from "../layout";
import { callLabel, parentChildEdges } from "../schema";

const NODE_W = 96;
const NODE_H = 40;

export function renderCallTree(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const count = frame.cells.length;
  const edges = parentChildEdges(frame.entries, count);
  const nodeWidth = Math.max(NODE_W, ...ctx.program.frames.flatMap((step) => step.cells.map((cell) => Math.min(240, callLabel(cell).length * 9 + 20))));
  const centres = layoutForest(count, edges, { x: origin.x, y: top }, {
    node: nodeWidth,
    nodeHeight: NODE_H,
    gap: 20,
    levelH: 70,
  });

  edges.forEach(([parent, child], edgeIndex) => {
    const from = centres[parent];
    const to = centres[child];
    if (!from || !to) return;
    out.push(linkArrow(ctx, `edge-${edgeIndex}`, from, to, NODE_H));
  });

  frame.cells.forEach((value, index) => {
    const centre = centres[index];
    if (!centre) return;
    const text = callLabel(value);
    const width = nodeWidth;
    out.push(
      ...cellBox(ctx, `frame-${index}`, centre.x - width / 2, centre.y - NODE_H / 2, text, {
        highlighted: isHighlighted(frame, index),
        width,
        height: NODE_H,
      }),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty call tree)"));
  }
  const bottom =
    centres.reduce((max, point) => Math.max(max, point.y), top) + NODE_H;
  return [...out, ...footer(ctx, bottom)];
}
