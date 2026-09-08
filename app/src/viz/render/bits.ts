/**
 * Fixed-width bit cells. A lone number in `cells` expands to binary;
 * `entries[0]` may name the width.
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
  type RenderContext,
} from "../layout";
import { cellText } from "../schema";

const BIT = 28;

function bitChars(frame: { cells: unknown[]; entries: unknown[] }): string[] {
  if (frame.cells.length === 1 && typeof frame.cells[0] === "number") {
    const widthRaw = frame.entries[0];
    const width =
      typeof widthRaw === "number" && widthRaw > 0
        ? Math.min(32, Math.round(widthRaw))
        : 8;
    const n = frame.cells[0];
    return Array.from({ length: width }, (_, i) =>
      ((n >> (width - 1 - i)) & 1) === 1 ? "1" : "0",
    );
  }
  return frame.cells.map((value) => {
    const text = cellText(value);
    return text === "1" || text === "true" ? "1" : "0";
  });
}

export function renderBits(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);
  const bits = bitChars(frame);

  bits.forEach((bit, index) => {
    const x = origin.x + index * (BIT + CELL_GAP);
    out.push(
      ...cellBox(ctx, `bit-${index}`, x, top, bit, {
        highlighted: isHighlighted(frame, index),
        width: BIT,
        height: BIT,
      }),
    );
    out.push(
      caption(ctx, `idx-${index}`, x + 4, top + BIT + 6, String(bits.length - 1 - index)),
    );
  });

  if (bits.length === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(no bits)"));
  }
  return [...out, ...footer(ctx, top + BIT + 24)];
}
