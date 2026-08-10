/**
 * Who owns the finger: the page camera, or a text selection.
 *
 * Board's scroll gatekeeper is a capture-phase listener on `.lc-board` that
 * claims every pointer and turns it into a pan. That is right for a document
 * you are reading and wrong for the one gesture that starts the same way and
 * means something else — a hold, then a drag, to pick out a quote.
 *
 * Rather than have the selection layer reach into Board's drag state, it raises
 * a flag here and Board's `canOwnScroll` reads it. One boolean, in a module
 * both already import, is the smallest seam that keeps the two gestures from
 * having to know each other's shapes.
 *
 * Module scope rather than a React context on purpose: the gatekeeper runs
 * inside a native listener installed once, and a context value read at render
 * time would be a frame stale exactly when it matters.
 */

let claimed = false;
let onClaimed: (() => void) | null = null;

/**
 * Board registers here so a mid-gesture claim can drop a deferred pan /
 * side-scroll that armed from the same finger before the hold landed.
 */
export function onSelectionGestureClaimed(handler: (() => void) | null): void {
  onClaimed = handler;
}

/** The selection has taken this gesture — Board must not pan on it. */
export function claimSelectionGesture(): void {
  claimed = true;
  onClaimed?.();
}

/** Hand the pointer back, on lift or when the hold is abandoned. */
export function releaseSelectionGesture(): void {
  claimed = false;
}

export function selectionOwnsGesture(): boolean {
  return claimed;
}
