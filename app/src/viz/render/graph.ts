/**
 * Graph: edges from `entries`, nodes laid out deterministically.
 *
 * A graph with no cycle is a tree or a forest, and a ring hides that shape —
 * a model asked to draw a tree as a graph got its nodes strung round a circle
 * with crossing arrows. Those draw as layered trees, rooted at the first node
 * of each component. A graph with a cycle keeps the ring: no force
 * simulation, no randomness, so the same program always draws the same
 * picture and frame stepping only moves the highlights.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
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
import { cellText, edgesHaveCycle, resolveNodeEdges } from "../schema";

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

/** Parent→child links that span every node reachable from each root, breadth first. */
function spanningLinks(count: number, edges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const near: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of edges) {
    near[a]!.push(b);
    near[b]!.push(a);
  }
  const seen = new Set<number>();
  const links: Array<[number, number]> = [];
  for (let root = 0; root < count; root++) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue = [root];
    while (queue.length) {
      const at = queue.shift()!;
      for (const next of near[at]!) {
        if (seen.has(next)) continue;
        seen.add(next);
        links.push([at, next]);
        queue.push(next);
      }
    }
  }
  return links;
}

/** A forest-shaped graph as layered trees; arrows keep each edge's own direction. */
function renderGraphAsForest(ctx: RenderContext, edges: Array<[number, number]>): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const labels = frame.cells.map(cellText);
  const longest = labels.reduce((n, label) => Math.max(n, label.length), 1);
  const w = Math.max(NODE, Math.min(128, longest * 8 + 22));
  const top = origin.y + headerOffset(ctx);
  const centres = layoutForest(labels.length, spanningLinks(labels.length, edges), { x: origin.x, y: top }, {
    node: w,
    nodeHeight: NODE,
    gap: 18,
    levelH: NODE + 42,
  });
  edges.forEach(([from, to], edgeIndex) => {
    const a = centres[from];
    const b = centres[to];
    if (a && b) out.push(linkArrow(ctx, `edge-${edgeIndex}`, a, b, NODE));
  });
  labels.forEach((label, index) => {
    const point = centres[index];
    if (!point) return;
    out.push(
      ...cellBox(ctx, `node-${index}`, point.x - w / 2, point.y - NODE / 2, label, {
        highlighted: isHighlighted(frame, index),
        width: w,
        height: NODE,
      }),
    );
  });
  const bottom = centres.reduce((max, point) => Math.max(max, point.y + NODE / 2), top);
  return [...out, ...footer(ctx, bottom + 8)];
}

export function renderGraph(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const count = frame.cells.length;
  const edges = resolveNodeEdges(frame.cells, frame.entries);
  if (count > 0 && edges.length > 0 && !edgesHaveCycle(count, edges)) return renderGraphAsForest(ctx, edges);
  const out = header(ctx);
  const radius = Math.max(MIN_RADIUS, count * RADIUS_PER_NODE);
  const centre = {
    x: origin.x + radius + NODE,
    y: origin.y + headerOffset(ctx) + radius + NODE / 2,
  };

  const labels = frame.cells.map(cellText);

  // Edges under the nodes.
  edges.forEach(([from, to], edgeIndex) => {

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
      ...cellBox(ctx, `node-${index}`, point.x - NODE / 2, point.y - NODE / 2, label, {
        highlighted: isHighlighted(frame, index),
        width: NODE,
        height: NODE,
      }),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, origin.y + headerOffset(ctx), "(no nodes)"));
  }
  return [...out, ...footer(ctx, centre.y + radius + NODE / 2)];
}
