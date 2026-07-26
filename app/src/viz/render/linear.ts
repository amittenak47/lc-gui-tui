/**
 * The linear structures: array, stack, queue.
 *
 * They share a cell strip and differ only in orientation and which ends get
 * named, so they share one implementation rather than three near-copies.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL,
  CELL_GAP,
  HEADER_H,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  pointersByIndex,
  type RenderContext,
} from "../layout";
import { cellText } from "../schema";

/** Horizontal cell strip with indices below and pointers above. */
export function renderArray(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H + 18; // Room for pointer labels above row.
  const pointers = pointersByIndex(frame);

  frame.cells.forEach((value, index) => {
    const x = origin.x + index * (CELL + CELL_GAP);
    out.push(
      cellBox(ctx, `cell-${index}`, x, top, cellText(value), {
        highlighted: isHighlighted(frame, index),
      }),
    );
    out.push(caption(ctx, `idx-${index}`, x + 4, top + CELL + 6, String(index)));

    const names = pointers.get(index);
    if (names) {
      out.push(
        caption(ctx, `ptr-${index}`, x + 4, top - 20, `${names.join(",")}↓`, { accent: true }),
      );
    }
  });

  if (frame.cells.length === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty)"));
  }
  return [...out, ...footer(ctx, top + CELL + 24)];
}

/** Vertical strip, index 0 at the bottom, `top` marked. */
export function renderStack(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const baseY = origin.y + HEADER_H;
  const count = frame.cells.length;

  frame.cells.forEach((value, index) => {
    // Index 0 is the bottom of the stack, so draw it last down the page.
    const y = baseY + (count - 1 - index) * (CELL + CELL_GAP);
    out.push(
      cellBox(ctx, `cell-${index}`, origin.x, y, cellText(value), {
        highlighted: isHighlighted(frame, index),
        width: CELL * 2,
      }),
    );
    if (index === count - 1) {
      out.push(caption(ctx, "top", origin.x + CELL * 2 + 10, y + 16, "← top", { accent: true }));
    }
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, baseY, "(empty stack)"));
  }
  return [...out, ...footer(ctx, baseY + Math.max(count, 1) * (CELL + CELL_GAP))];
}

/** Horizontal strip with front and back named. */
export function renderQueue(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H + 18;
  const count = frame.cells.length;

  frame.cells.forEach((value, index) => {
    const x = origin.x + index * (CELL + CELL_GAP);
    out.push(
      cellBox(ctx, `cell-${index}`, x, top, cellText(value), {
        highlighted: isHighlighted(frame, index),
      }),
    );
    if (index === 0) {
      out.push(caption(ctx, "front", x, top - 20, "front", { accent: true }));
    }
    if (index === count - 1 && count > 1) {
      out.push(caption(ctx, "back", x, top + CELL + 6, "back", { accent: true }));
    }
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty queue)"));
  }
  return [...out, ...footer(ctx, top + CELL + 24)];
}
