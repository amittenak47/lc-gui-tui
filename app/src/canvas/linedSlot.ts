/**
 * Placement of the ruled overlay, and when recomputing it may be skipped.
 *
 * The geometry is written straight onto the DOM node rather than through React,
 * because it changes on every camera move and re-rendering the board for it
 * would be absurd. That makes the skip test subtle: the node is *mounted* by
 * React one render after the first pass computes numbers for it, so the first
 * pass always has numbers and no node to put them on.
 *
 * Remembering the numbers anyway — which is what the old inline check did —
 * meant the second pass compared equal and returned early, before writing
 * anything. On a board whose camera then never moved again, that was every
 * subsequent pass: the rules mounted at zero size and stayed there. Desktop hid
 * it, because something always jiggled the camera enough to break the tie.
 */

export interface LinedSlot {
  left: number;
  top: number;
  width: number;
  height: number;
  gap: number;
  phase: number;
}

export function sameLinedSlot(a: LinedSlot, b: LinedSlot): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.gap === b.gap &&
    a.phase === b.phase
  );
}

/**
 * Whether this pass can leave the overlay alone.
 *
 * Only when the numbers are unchanged *and* there is a node currently wearing
 * them. No node means nothing has been written yet, whatever was computed last
 * time.
 */
export function linedSlotCanSkip(
  prev: LinedSlot | null,
  next: LinedSlot,
  hasNode: boolean,
): boolean {
  if (!hasNode) return false;
  if (!prev) return false;
  return sameLinedSlot(prev, next);
}
