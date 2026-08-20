/**
 * Straightening part of a stroke without ending it.
 *
 * The straight-line toggle used to mean "this whole stroke is a chord", which
 * is the only shape a mode can have: you turn it on, draw, turn it off. Holding
 * Shift is a different thing — it straightens from the moment you press until
 * the moment you let go, in the middle of a stroke you are already drawing, and
 * you keep drawing afterwards. One gesture, three parts, no lift.
 *
 * Both end up here. The toggle is the same rule with the anchor pinned at the
 * start of the stroke, which is what makes it a special case of the gesture
 * rather than a second code path beside it. Touch keeps the toggle because a
 * tablet has no Shift key.
 */

/** A point the ink layer is carrying. Only identity matters here. */
export type AnchoredPoint = unknown;

/**
 * Where the chord starts, or `null` for ordinary freehand.
 *
 * Shift wins when both are on: it is the live gesture, and the reader pressing
 * a key mid-stroke means the thing they are doing now, not the mode they set
 * earlier.
 */
export function straightAnchorFor(
  toggleOn: boolean,
  shiftAnchor: number | null,
): number | null {
  if (shiftAnchor != null) return shiftAnchor;
  return toggleOn ? 0 : null;
}

/**
 * The stroke as it should look with the tail straightened from `anchor`.
 *
 * Everything up to and including the anchor is the freehand the reader already
 * drew and must not move. Everything after it collapses to a single point — the
 * live nib — so the tail is one chord however far the pen has travelled.
 */
export function straightenFromAnchor<T>(
  points: readonly T[],
  anchor: number,
  point: T,
): T[] {
  if (points.length === 0) return [point];
  const cut = Math.max(0, Math.min(anchor, points.length - 1));
  return [...points.slice(0, cut + 1), point];
}

/**
 * Anchor for a Shift press landing now.
 *
 * Mid-stroke it is the last point drawn, so the chord starts under the nib.
 * Before a stroke it is the start, which makes Shift-then-draw a straight line
 * from the first contact — what every drawing app does, and what the toggle
 * already did.
 */
export function shiftAnchorAt(livePointCount: number | null): number {
  if (livePointCount == null || livePointCount <= 0) return 0;
  return livePointCount - 1;
}
