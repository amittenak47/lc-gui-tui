/**
 * Shared geometry for the viz renderers.
 *
 * Every renderer builds ids through {@link slotId}, which is what makes frame
 * stepping *replace* elements instead of accumulating them: the cell at index 3
 * is `…-cell-3` in every frame, so `updateScene` overwrites it in place.
 */

import {
  COACH_ACCENT,
  COACH_FILL,
  COACH_INK,
  FONT_CODE,
  vizElementId,
  type Skeleton,
} from "../templates/skeleton";
import type { VizFrame, VizProgram } from "./schema";

export const CELL = 52;
export const CELL_GAP = 6;
export const ROW_GAP = 44;
/** Height reserved above the structure for the title and frame label. */
export const HEADER_H = 56;

export interface RenderContext {
  program: VizProgram;
  frame: VizFrame;
  frameIndex: number;
  /** Top-left of this diagram's slot in the agent lane. */
  origin: { x: number; y: number };
}

export type Renderer = (ctx: RenderContext) => Skeleton[];

export function slotId(ctx: RenderContext, slot: string): string {
  return vizElementId(ctx.program.id, slot);
}

/** A boxed cell with its value centred. */
export function cellBox(
  ctx: RenderContext,
  slot: string,
  x: number,
  y: number,
  text: string,
  options: { highlighted?: boolean; width?: number; height?: number } = {},
): Skeleton {
  const highlighted = options.highlighted ?? false;
  return {
    id: slotId(ctx, slot),
    type: "rectangle",
    x,
    y,
    width: options.width ?? CELL,
    height: options.height ?? CELL,
    strokeColor: highlighted ? COACH_ACCENT : COACH_INK,
    backgroundColor: highlighted ? "#fff7ed" : COACH_FILL,
    fillStyle: "solid",
    strokeWidth: highlighted ? 2 : 1,
    roughness: 0,
    label: { text, fontSize: 16, strokeColor: highlighted ? COACH_ACCENT : "#1e1e1e" },
  };
}

/** Small caption text, e.g. an index below a cell or a pointer name above it. */
export function caption(
  ctx: RenderContext,
  slot: string,
  x: number,
  y: number,
  text: string,
  options: { accent?: boolean; fontSize?: number } = {},
): Skeleton {
  return {
    id: slotId(ctx, slot),
    type: "text",
    x,
    y,
    text,
    fontSize: options.fontSize ?? 13,
    fontFamily: FONT_CODE,
    strokeColor: options.accent ? COACH_ACCENT : COACH_INK,
  };
}

export function arrow(
  ctx: RenderContext,
  slot: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { accent?: boolean } = {},
): Skeleton {
  return {
    id: slotId(ctx, slot),
    type: "arrow",
    x: from.x,
    y: from.y,
    points: [
      [0, 0],
      [to.x - from.x, to.y - from.y],
    ],
    strokeColor: options.accent ? COACH_ACCENT : COACH_INK,
    strokeWidth: 1,
    roughness: 0,
  };
}

/**
 * Title and frame label, shared by every renderer so the header never drifts
 * between structures.
 */
export function header(ctx: RenderContext): Skeleton[] {
  const { origin, program, frame, frameIndex } = ctx;
  const out: Skeleton[] = [
    caption(ctx, "title", origin.x, origin.y, program.title || program.id, {
      fontSize: 18,
    }),
  ];
  const step =
    program.frames.length > 1
      ? `[${frameIndex + 1}/${program.frames.length}] ${frame.label}`
      : frame.label;
  if (step.trim().length > 0) {
    out.push(caption(ctx, "framelabel", origin.x, origin.y + 26, step, { accent: true }));
  }
  return out;
}

/** The frame's note, placed under a structure of the given height. */
export function footer(ctx: RenderContext, belowY: number): Skeleton[] {
  if (!ctx.frame.note.trim()) return [];
  return [caption(ctx, "note", ctx.origin.x, belowY + 12, wrap(ctx.frame.note, 52))];
}

/** Hard-wrap a note so it stays inside the agent lane. */
export function wrap(text: string, columns: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
}

/** Pointer names grouped by the index they point at, in declaration order. */
export function pointersByIndex(frame: VizFrame): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const [name, index] of Object.entries(frame.pointers)) {
    const existing = grouped.get(index);
    if (existing) existing.push(name);
    else grouped.set(index, [name]);
  }
  return grouped;
}

export function isHighlighted(frame: VizFrame, index: number): boolean {
  return frame.highlight.includes(index);
}
