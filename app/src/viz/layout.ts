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
import { cellText, type VizFrame, type VizProgram } from "./schema";

export const CELL = 52;
export const CELL_GAP = 6;
export const ROW_GAP = 44;
/** Height reserved above the structure for the title and frame label. */
export const HEADER_H = 56;

/** One column pitch for the entire trace, so large values cannot overlap or make it jump. */
export function traceCellWidth(ctx: RenderContext): number {
  let width = CELL;
  for (const frame of ctx.program.frames) {
    for (const value of frame.cells.flat()) width = Math.max(width, Math.min(160, cellText(value).length * 10 + 20));
  }
  return width;
}

export interface RenderContext {
  program: VizProgram;
  frame: VizFrame;
  frameIndex: number;
  /** Top-left of this diagram's slot in the agent lane. */
  origin: { x: number; y: number };
  /** Skip title/note — user stamps share the layout without the coach header. */
  bare?: boolean;
  /** Override coach colours when the same layout is a student stamp. */
  palette?: { ink: string; fill: string; accent?: string };
}

export type Renderer = (ctx: RenderContext) => Skeleton[];

export function headerOffset(ctx: RenderContext): number {
  return ctx.bare ? 0 : HEADER_H;
}

function strokeOf(ctx: RenderContext, accent = false): string {
  if (accent) return ctx.palette?.accent ?? COACH_ACCENT;
  return ctx.palette?.ink ?? COACH_INK;
}

function fillOf(ctx: RenderContext, highlighted: boolean): string {
  if (highlighted) return "#fff7ed";
  return ctx.palette?.fill ?? COACH_FILL;
}

export function slotId(ctx: RenderContext, slot: string): string {
  return vizElementId(ctx.program.id, slot);
}

/**
 * A boxed cell with its value as a bound label centred in the rectangle.
 *
 * Separate text siblings were supposed to sit in the box via
 * `textAlign`/`verticalAlign`/`autoResize:false`, but Excalidraw's convert
 * path still anchors them top-left and clips long values. Bound labels use
 * the container's box; with `regenerateIds: false` on viz convert the ids
 * stay stable across frames (the reason labels were abandoned earlier).
 */
export function cellBox(
  ctx: RenderContext,
  slot: string,
  x: number,
  y: number,
  text: string,
  options: { highlighted?: boolean; width?: number; height?: number } = {},
): Skeleton[] {
  const highlighted = options.highlighted ?? false;
  // Long values (e.g. 1800) need a wider box than the default digit cell.
  const width = options.width ?? Math.max(CELL, text.length * 12 + 20);
  const height = options.height ?? CELL;
  const ink = highlighted ? (ctx.palette?.accent ?? COACH_ACCENT) : strokeOf(ctx);
  return [
    {
      id: slotId(ctx, slot),
      type: "rectangle",
      x,
      y,
      width,
      height,
      strokeColor: highlighted ? (ctx.palette?.accent ?? COACH_ACCENT) : strokeOf(ctx),
      backgroundColor: fillOf(ctx, highlighted),
      fillStyle: "solid",
      strokeWidth: highlighted ? 2 : 1,
      roughness: 0,
      roundness: { type: 3 },
      label: {
        text,
        fontSize: 16,
        strokeColor: ink,
        textAlign: "center",
        verticalAlign: "middle",
      },
    },
  ];
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
    strokeColor: strokeOf(ctx, options.accent),
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
    strokeColor: strokeOf(ctx, options.accent),
    strokeWidth: 1,
    roughness: 0,
  };
}

/**
 * Title and frame label, shared by every renderer so the header never drifts
 * between structures.
 */
export function header(ctx: RenderContext): Skeleton[] {
  if (ctx.bare) return [];
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
  if (ctx.bare || !ctx.frame.note.trim()) return [];
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

/**
 * Centres for an arbitrary parent→child forest (trie, union-find, call tree).
 *
 * Not the heap `2i+1` rule — edges come from `entries`. Isolated nodes sit in
 * a row of their own.
 */
export function layoutForest(
  count: number,
  parentToChild: Array<[number, number]>,
  origin: { x: number; y: number },
  options: { node?: number; gap?: number; levelH?: number } = {},
): Array<{ x: number; y: number }> {
  const node = options.node ?? 44;
  const gap = options.gap ?? 16;
  const levelH = options.levelH ?? 78;
  const unit = node + gap;
  if (count <= 0) return [];

  const children: number[][] = Array.from({ length: count }, () => []);
  const indeg = new Array(count).fill(0);
  for (const [parent, child] of parentToChild) {
    if (
      parent === child ||
      parent < 0 ||
      child < 0 ||
      parent >= count ||
      child >= count
    ) {
      continue;
    }
    children[parent]!.push(child);
    indeg[child] += 1;
  }

  const roots: number[] = [];
  for (let i = 0; i < count; i++) if (indeg[i] === 0) roots.push(i);
  if (roots.length === 0) roots.push(0);

  const subtreeWidth = (index: number, visiting: Set<number>): number => {
    if (visiting.has(index)) return unit;
    visiting.add(index);
    const kids = children[index] ?? [];
    if (kids.length === 0) {
      visiting.delete(index);
      return unit;
    }
    let sum = 0;
    for (const kid of kids) sum += subtreeWidth(kid, visiting);
    visiting.delete(index);
    return Math.max(unit, sum);
  };

  const positions = Array.from({ length: count }, () => ({ x: origin.x, y: origin.y }));
  const placed = new Set<number>();

  const place = (index: number, left: number, depth: number) => {
    if (placed.has(index)) return;
    placed.add(index);
    const width = subtreeWidth(index, new Set());
    positions[index] = { x: left + width / 2, y: origin.y + depth * levelH };
    let cursor = left;
    for (const kid of children[index] ?? []) {
      const kidWidth = subtreeWidth(kid, new Set());
      place(kid, cursor, depth + 1);
      cursor += kidWidth;
    }
  };

  let cursor = origin.x;
  for (const root of roots) {
    const width = subtreeWidth(root, new Set());
    place(root, cursor, 0);
    cursor += width + gap;
  }
  for (let i = 0; i < count; i++) {
    if (placed.has(i)) continue;
    positions[i] = { x: cursor + node / 2, y: origin.y };
    cursor += unit;
  }
  return positions;
}

/** Arrow between two node centres, stopping short of the boxes. */
export function linkArrow(
  ctx: RenderContext,
  slot: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  node = 44,
): Skeleton {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const inset = node / 2 + 4;
  return arrow(
    ctx,
    slot,
    { x: from.x + (dx / length) * inset, y: from.y + (dy / length) * inset },
    { x: to.x - (dx / length) * inset, y: to.y - (dy / length) * inset },
  );
}
