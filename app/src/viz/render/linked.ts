/**
 * Linked list: boxes joined by arrows, ending in a null marker.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL,
  HEADER_H,
  arrow,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  pointersByIndex,
  type RenderContext,
} from "../layout";
import { cellText } from "../schema";

const NODE_W = CELL + 12;
const LINK = 34;

export function renderLinkedList(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H + 18;
  const pointers = pointersByIndex(frame);
  const stride = NODE_W + LINK;

  frame.cells.forEach((value, index) => {
    const x = origin.x + index * stride;
    out.push(
      cellBox(ctx, `node-${index}`, x, top, cellText(value), {
        highlighted: isHighlighted(frame, index),
        width: NODE_W,
      }),
    );

    // Link to the next node, or the null terminator.
    out.push(
      arrow(
        ctx,
        `link-${index}`,
        { x: x + NODE_W, y: top + CELL / 2 },
        { x: x + NODE_W + LINK - 4, y: top + CELL / 2 },
      ),
    );

    const names = pointers.get(index);
    if (names) {
      out.push(
        caption(ctx, `ptr-${index}`, x + 4, top - 20, `${names.join(",")}↓`, { accent: true }),
      );
    }
  });

  const endX = origin.x + frame.cells.length * stride;
  out.push(
    frame.cells.length > 0
      ? caption(ctx, "null", endX, top + CELL / 2 - 8, "∅")
      : caption(ctx, "empty", origin.x, top, "(empty list)"),
  );

  return [...out, ...footer(ctx, top + CELL + 12)];
}
