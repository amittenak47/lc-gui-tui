/**
 * Graph: nodes on a circle, edges from `entries`.
 *
 * A circular layout is the deterministic choice — no force simulation, no
 * randomness, so the same program always draws the same picture and frame
 * stepping only moves the highlights.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  HEADER_H,
  arrow,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  type RenderContext,
} from "../layout";
import { cellText, entryPair } from "../schema";

const NODE = 44;
const RADIUS_PER_NODE = 13;
const MIN_RADIUS = 70;

function nodeCentre(
  index: number,
  count: number,
  centre: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  // Start at the top and go clockwise, so node 0 is always where you expect.
  const angle = -Math.PI / 2 + (index / Math.max(count, 1)) * Math.PI * 2;
  return {
    x: centre.x + Math.cos(angle) * radius,
    y: centre.y + Math.sin(angle) * radius,
  };
}

export function renderGraph(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const count = frame.cells.length;
  const radius = Math.max(MIN_RADIUS, count * RADIUS_PER_NODE);
  const centre = {
    x: origin.x + radius + NODE,
    y: origin.y + HEADER_H + radius + NODE / 2,
  };

  const labels = frame.cells.map(cellText);
  /** Resolve an edge endpoint by node label first, then by index. */
  const indexOf = (token: string): number => {
    const byLabel = labels.indexOf(token);
    if (byLabel >= 0) return byLabel;
    const asIndex = Number(token);
    return Number.isInteger(asIndex) && asIndex >= 0 && asIndex < count ? asIndex : -1;
  };

  // Edges under the nodes.
  frame.entries.forEach((entry, edgeIndex) => {
    const pair = entryPair(entry);
    if (!pair) return;
    const from = indexOf(pair[0]);
    const to = indexOf(pair[1]);
    if (from < 0 || to < 0 || from === to) return;

    const a = nodeCentre(from, count, centre, radius);
    const b = nodeCentre(to, count, centre, radius);
    // Stop short of the node boxes so the arrowhead stays visible.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const inset = NODE / 2 + 4;
    out.push(
      arrow(
        ctx,
        `edge-${edgeIndex}`,
        { x: a.x + (dx / length) * inset, y: a.y + (dy / length) * inset },
        { x: b.x - (dx / length) * inset, y: b.y - (dy / length) * inset },
      ),
    );
  });

  labels.forEach((label, index) => {
    const point = nodeCentre(index, count, centre, radius);
    out.push(
      cellBox(ctx, `node-${index}`, point.x - NODE / 2, point.y - NODE / 2, label, {
        highlighted: isHighlighted(frame, index),
        width: NODE,
        height: NODE,
      }),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, origin.y + HEADER_H, "(no nodes)"));
  }
  return [...out, ...footer(ctx, centre.y + radius + NODE / 2)];
}
