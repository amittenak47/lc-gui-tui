/**
 * DP strip and DP table.
 *
 * `dplist`: 1D `dp[]` with predecessor links in `entries`.
 * `dptable`: a grid, optional axis labels as the first scalar lists in `entries`,
 * and optional pred arrows as `[from, to]` flat indices.
 */

import type { Skeleton } from "../../templates/skeleton";
import {
  CELL,
  CELL_GAP,
  headerOffset,
  arrow,
  caption,
  cellBox,
  footer,
  header,
  isHighlighted,
  traceCellWidth,
  type RenderContext,
} from "../layout";
import { cellText, entryPair } from "../schema";

function intList(entries: unknown[]): number[] | null {
  if (entries.length === 0) return null;
  const nums = entries.map((entry) => {
    if (typeof entry === "number" && Number.isInteger(entry)) return entry;
    if (typeof entry === "string" && Number.isInteger(Number(entry))) return Number(entry);
    return NaN;
  });
  return nums.every(Number.isInteger) ? nums : null;
}

function scalarList(entry: unknown): string[] | null {
  if (!Array.isArray(entry) || entry.length === 0) return null;
  if (entry.some((item) => item !== null && typeof item === "object")) return null;
  return entry.map((item) => cellText(item));
}

export function renderDpList(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx) + 18;
  const count = frame.cells.length;
  const width = traceCellWidth(ctx);

  frame.cells.forEach((value, index) => {
    const x = origin.x + index * (width + CELL_GAP);
    out.push(
      ...cellBox(ctx, `cell-${index}`, x, top, cellText(value), {
        highlighted: isHighlighted(frame, index),
        width,
      }),
    );
    out.push(caption(ctx, `idx-${index}`, x + 4, top + CELL + 6, String(index)));
  });

  const preds = intList(frame.entries);
  const links: Array<[number, number]> =
    preds && preds.length === count
      ? preds.flatMap((pred, index) =>
          Number.isInteger(pred) && pred >= 0 && pred < count && pred !== index
            ? [[index, pred] as [number, number]]
            : [],
        )
      : frame.entries.flatMap((entry) => {
          const pair = entryPair(entry);
          if (!pair) return [];
          const from = Number(pair[0]);
          const to = Number(pair[1]);
          if (
            Number.isInteger(from) &&
            Number.isInteger(to) &&
            from >= 0 &&
            to >= 0 &&
            from < count &&
            to < count &&
            from !== to
          ) {
            return [[from, to] as [number, number]];
          }
          return [];
        });

  const predY = top + CELL + 28;
  links.forEach(([from, to], edgeIndex) => {
    const x1 = origin.x + from * (width + CELL_GAP) + width / 2;
    const x2 = origin.x + to * (width + CELL_GAP) + width / 2;
    out.push(
      arrow(ctx, `pred-${edgeIndex}`, { x: x1, y: predY }, { x: x2, y: predY }, { accent: true }),
    );
  });

  if (count === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty dp)"));
  }
  return [...out, ...footer(ctx, predY + (links.length > 0 ? 12 : 0))];
}

export function renderDpTable(ctx: RenderContext): Skeleton[] {
  const { frame, origin } = ctx;
  const out = header(ctx);
  const top = origin.y + headerOffset(ctx);

  const rows: unknown[][] = frame.cells.every((row) => Array.isArray(row))
    ? (frame.cells as unknown[][])
    : [frame.cells];

  let colLabels: string[] | null = null;
  let rowLabels: string[] | null = null;
  const leftover: unknown[] = [];
  for (const entry of frame.entries) {
    const labels = scalarList(entry);
    if (labels && !colLabels) {
      colLabels = labels;
      continue;
    }
    if (labels && !rowLabels) {
      rowLabels = labels;
      continue;
    }
    leftover.push(entry);
  }

  // Reserve the same geometry across the trace, including room for arrowheads
  // between cells. Centre-to-centre arrows disappear under the cell fills.
  const width = Math.max(traceCellWidth(ctx), ...ctx.program.frames.flatMap(f =>
    scalarList(f.entries[0])?.map(label => label.length * 8 + 12) ?? []));
  const labelW = rowLabels ? Math.max(36, ...ctx.program.frames.flatMap(f =>
    scalarList(f.entries[1])?.map(label => label.length * 8 + 12) ?? [])) : 0;
  const gap = 24;
  const gridX = origin.x + labelW;
  const gridY = top + (colLabels ? 22 : 0);

  if (colLabels) {
    colLabels.forEach((label, c) => {
      out.push(
        caption(ctx, `colh-${c}`, gridX + c * (width + gap) + 4, top, label, { accent: true }),
      );
    });
  }
  if (rowLabels) {
    rowLabels.forEach((label, r) => {
      out.push(
        caption(ctx, `rowh-${r}`, origin.x, gridY + r * (CELL + gap) + 16, label, {
          accent: true,
        }),
      );
    });
  }

  let flat = 0;
  const centres: Array<{ x: number; y: number }> = [];
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const index = flat++;
      const x = gridX + c * (width + gap);
      const y = gridY + r * (CELL + gap);
      centres[index] = { x: x + width / 2, y: y + CELL / 2 };
      out.push(
        ...cellBox(ctx, `cell-${r}-${c}`, x, y, cellText(value), {
          highlighted: isHighlighted(frame, index),
          width,
        }),
      );
    });
  });

  leftover.forEach((entry, edgeIndex) => {
    const pair = entryPair(entry);
    if (!pair) return;
    const from = Number(pair[0]);
    const to = Number(pair[1]);
    const a = centres[from];
    const b = centres[to];
    if (!a || !b || from === to) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = 1 / Math.max(Math.abs(dx) / (width / 2 + 2), Math.abs(dy) / (CELL / 2 + 2));
    out.push(arrow(ctx, `pred-${edgeIndex}`,
      { x: a.x + dx * t, y: a.y + dy * t },
      { x: b.x - dx * t, y: b.y - dy * t }, { accent: true }));
  });

  if (rows.length === 0 || (rows[0]?.length ?? 0) === 0) {
    out.push(caption(ctx, "empty", origin.x, top, "(empty dp table)"));
  }
  const bottom = gridY + Math.max(rows.length, 1) * (CELL + gap);
  return [...out, ...footer(ctx, bottom)];
}
