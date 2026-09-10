/**
 * Union-find: `cells` is parent[], `entries` is rank[] when it is a number list.
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
import { cellText } from "../schema";

const NODE = 44;

function parentOf(value: unknown, index: number, count: number): number {
  const n = Number(typeof value === "string" || typeof value === "number" ? value : cellText(value));
  if (Number.isInteger(n) && n >= 0 && n < count) return n;
  return index;
}

function ranksOf(entries: unknown[], count: number): number[] | null {
  if (entries.length !== count || count === 0) return null;
  const ranks = entries.map((entry) => {
    if (typeof entry === "number" && Number.isInteger(entry)) return entry;
    if (typeof entry === "string" && Number.isInteger(Number(entry))) return Number(entry);
    return NaN;
  });
  return ranks.every(Number.isInteger) ? ranks : null;
}

export function renderUnionFind(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const count = frame.cells.length;
  const parent = frame.cells.map((value, index) => parentOf(value, index, count));
  const ranks = ranksOf(frame.entries, count);
  const edges: Array<[number, number]> = [];
  parent.forEach((root, index) => {
    if (root !== index) edges.push([root, index]);
  });
  const centres = layoutForest(count, edges, { x: origin.x, y: top }, { node: NODE });

  edges.forEach(([from, to]) => {
    const a = centres[from];
    const b = centres[to];
    if (!a || !b) return;
    // Parent pointers point from a member to its root, not down a child tree.
    out.push(linkArrow(ctx, `edge-${to}-${from}`, b, a, NODE));
  });

  for (let index = 0; index < count; index++) {
    const centre = centres[index];
    if (!centre) continue;
    const rank = ranks ? ` r${ranks[index]}` : "";
    out.push(
      ...cellBox(
        ctx,
        `node-${index}`,
        centre.x - NODE / 2,
        centre.y - NODE / 2,
        `${index}${rank}`,
        {
          highlighted: isHighlighted(frame, index),
          width: NODE,
          height: NODE,
        },
      ),
    );
  }

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty union-find)"));
  }
  const bottom =
    centres.reduce((max, point) => Math.max(max, point.y), top) + NODE;
  return [...out, ...footer(ctx, bottom)];
}
