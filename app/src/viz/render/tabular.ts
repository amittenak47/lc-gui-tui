/**
 * The tabular structures: grid and hashmap.
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
  type RenderContext,
} from "../layout";
import { cellText, entryPair } from "../schema";

/**
 * 2D grid. `cells` is an array of rows; a flat array is treated as one row so a
 * model that forgets to nest still renders something readable.
 *
 * `highlight` indexes the *flattened* grid in row-major order, which is how the
 * model is told to count in the tool schema.
 */
export function renderGrid(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H;

  const rows: unknown[][] = frame.cells.every((row) => Array.isArray(row))
    ? (frame.cells as unknown[][])
    : [frame.cells];

  let flat = 0;
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const index = flat++;
      out.push(
        cellBox(
          ctx,
          `cell-${r}-${c}`,
          origin.x + c * (CELL + CELL_GAP),
          top + r * (CELL + CELL_GAP),
          cellText(value),
          { highlighted: isHighlighted(frame, index) },
        ),
      );
    });
  });

  if (rows.length === 0 || rows[0].length === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty grid)"));
  }
  return [...out, ...footer(ctx, top + Math.max(rows.length, 1) * (CELL + CELL_GAP))];
}

/**
 * Key → value rows, from `entries`. Falls back to `cells` used as keys with no
 * values, which is what a model does when it means "a set".
 */
export function renderHashmap(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + HEADER_H;
  const KEY_W = CELL * 2;
  const VAL_W = CELL * 2;
  const ROW_H = 36;

  const pairs: Array<[string, string]> =
    frame.entries.length > 0
      ? frame.entries
          .map(entryPair)
          .filter((pair): pair is [string, string] => pair !== null)
      : frame.cells.map((value) => [cellText(value), ""] as [string, string]);

  out.push(caption(ctx, "colkey", origin.x + 4, top - 18, "key"));
  out.push(caption(ctx, "colval", origin.x + KEY_W + CELL_GAP + 4, top - 18, "value"));

  pairs.forEach(([key, value], index) => {
    const y = top + index * (ROW_H + CELL_GAP);
    const highlighted = isHighlighted(frame, index);
    out.push(
      cellBox(ctx, `key-${index}`, origin.x, y, key, {
        highlighted,
        width: KEY_W,
        height: ROW_H,
      }),
    );
    out.push(
      cellBox(ctx, `val-${index}`, origin.x + KEY_W + CELL_GAP, y, value, {
        highlighted,
        width: VAL_W,
        height: ROW_H,
      }),
    );
  });

  if (pairs.length === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty map)"));
  }
  return [...out, ...footer(ctx, top + Math.max(pairs.length, 1) * (ROW_H + CELL_GAP))];
}
