/**
 * Where a conflict pane draws one page's handwriting.
 *
 * Strokes are stored in board scene coordinates — an absolute Y down the whole
 * stack — and bucketed by which page frame contains them. A pane lays the same
 * document out at its own width, so drawing them means two things: a scale
 * from scene units to this pane's pixels, and the scene Y the page starts at.
 *
 * Getting the second one wrong is not a small error. Without it every page's
 * ink is painted as though the book began at that page, which on page 40 of a
 * textbook is ink somewhere off the bottom of the world.
 */

import type { PageFrame } from "../canvas/inkPageIndex";

/** A page's box in the pane, relative to the document element. */
export interface ConflictInkSlot {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConflictInkPlacement {
  /** Scene units → pane pixels. */
  scale: number;
  /** The scene Y this page starts at; the paint origin. */
  originY: number;
}

/**
 * The transform for one page's strokes.
 *
 * A missing frame falls back to a zero origin, which is what this did before
 * frames were passed at all: wrong for every page but the first, and better
 * than refusing to draw handwriting the reader is being asked to choose about.
 */
export function conflictInkPlacement(
  slot: ConflictInkSlot,
  frame: PageFrame | undefined,
  sceneWidth: number | undefined,
): ConflictInkPlacement {
  const scale = sceneWidth && sceneWidth > 0 ? slot.width / sceneWidth : 1;
  return { scale, originY: frame ? frame.minY : 0 };
}

/**
 * Which pages actually carry strokes, in order.
 *
 * Page 0 is the spanning shard — strokes whose box crosses a page gap. It
 * belongs to no single slot, so there is nowhere on one page to draw it, and
 * treating it as a page id would put it on page one.
 */
export function inkedPageIds(
  rows: readonly { page_id: number }[] | undefined,
): number[] {
  const ids = new Set<number>();
  for (const row of rows ?? []) {
    if (row.page_id >= 1) ids.add(row.page_id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** True when two measured slot lists describe the same boxes. */
export function inkSlotsEqual(
  a: readonly ConflictInkSlot[],
  b: readonly ConflictInkSlot[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((slot, i) => {
    const other = b[i]!;
    return (
      slot.page === other.page &&
      Math.abs(slot.left - other.left) < 1 &&
      Math.abs(slot.top - other.top) < 1 &&
      Math.abs(slot.width - other.width) < 1 &&
      Math.abs(slot.height - other.height) < 1
    );
  });
}
