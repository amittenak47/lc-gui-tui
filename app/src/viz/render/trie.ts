/**
 * Trie: nodes `{ch, end}` with parent→child edges in `entries`.
 *
 * Not a heap. The model names the links; faking `2i+1` would draw the wrong tree.
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
import { parentChildEdges, trieNode } from "../schema";

const NODE = 40;

export function renderTrie(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const count = frame.cells.length;
  const edges = parentChildEdges(frame.entries, count);
  const centres = layoutForest(count, edges, { x: origin.x, y: top }, { node: NODE });

  edges.forEach(([parent, child], edgeIndex) => {
    const from = centres[parent];
    const to = centres[child];
    if (!from || !to) return;
    out.push(linkArrow(ctx, `edge-${edgeIndex}`, from, to, NODE));
  });

  frame.cells.forEach((value, index) => {
    const centre = centres[index];
    if (!centre) return;
    const node = trieNode(value);
    const text = node.end ? `${node.ch || "ε"}●` : node.ch || "ε";
    out.push(
      ...cellBox(ctx, `node-${index}`, centre.x - NODE / 2, centre.y - NODE / 2, text, {
        highlighted: isHighlighted(frame, index) || node.end,
        width: NODE,
        height: NODE,
      }),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty trie)"));
  }
  const bottom =
    centres.reduce((max, point) => Math.max(max, point.y), top) + NODE;
  return [...out, ...footer(ctx, bottom)];
}
