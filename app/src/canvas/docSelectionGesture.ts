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
 *
 * The same module carries "camera is live" for footnote ribbon placement: a
 * MutationObserver that re-measures ribbons mid-flick starves ink tile paint.
 * DocSelectionLayer defers `place()` until the camera settles.
 */

import { noteCameraBusy } from "../util/cameraBusy";

let claimed = false;
let onClaimed: (() => void) | null = null;

let cameraLive = false;
let onCameraLiveChange: ((live: boolean) => void) | null = null;

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
  noteCameraBusy();
  onClaimed?.();
}

/** Hand the pointer back, on lift or when the hold is abandoned. */
export function releaseSelectionGesture(): void {
  claimed = false;
}

export function selectionOwnsGesture(): boolean {
  return claimed;
}

/** Board's reading camera is mid-gesture (pulse / coast). */
export function setDocCameraLive(live: boolean): void {
  if (cameraLive === live) return;
  cameraLive = live;
  onCameraLiveChange?.(live);
}

export function isDocCameraLive(): boolean {
  return cameraLive;
}

/** DocSelectionLayer flushes deferred ribbon placement when live goes false. */
export function onDocCameraLiveChange(handler: ((live: boolean) => void) | null): void {
  onCameraLiveChange = handler;
}

/* ----------------------------------------------------- edge auto-scroll --- */

let onScrollRequest: ((dy: number) => number) | null = null;

/**
 * Board offers the reading camera a nudge, for a selection dragged off the edge.
 *
 * The same seam as the claim flag above, and for the same reason: the camera's
 * clamping, its inertia and its idea of where the page ends all live in Board,
 * and a selection layer that computed a scroll position itself would be a
 * second implementation of that arithmetic — one that would go wrong at exactly
 * the top and bottom of the document, which is where a drag off the edge always
 * ends up.
 *
 * The handler returns how far it *actually* moved. At the end of the document
 * that is zero, which is what tells the caller to stop asking rather than spin
 * a frame loop against a wall.
 */
export function onDocScrollRequest(handler: ((dy: number) => number) | null): void {
  onScrollRequest = handler;
}

/** Ask for `dy` pixels of page scroll. Returns what was granted. */
export function requestDocScroll(dy: number): number {
  return onScrollRequest?.(dy) ?? 0;
}

/* ------------------------------------------------ overlay chrome hits --- */

/**
 * Controls painted over the page that own their own taps.
 *
 * Capture-phase listeners on the selection host / window run before React
 * handlers on the control, so `stopPropagation` on the chip itself is too
 * late. Name every overlay that sits on top of the words.
 *
 * `.lc-color-wheel` is portaled to `document.body` from ColorRadial — it is
 * not inside `.lc-footnote-overview`. Without it, underline capture steals
 * the hub tap and the footnote closer dismisses the card.
 */
const DOC_CHROME_SELECTOR =
  ".lc-doc-footnote, .lc-doc-confirm, .lc-doc-sheet, .lc-doc-sheet-backdrop, .lc-doc-selection-chrome, .lc-footnote-overview, .lc-doc-submark-grip, .lc-split-sash, .lc-color-wheel";

export function isDocChromeTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(element?.closest?.(DOC_CHROME_SELECTOR));
}

/* ----------------------------------------------- sub-mark pointer hit --- */

/**
 * Overview card uses this so a tap inside the open mark does not close the
 * panel. Board pan ignores it — only {@link isSubMarkDragLive} steals the finger.
 */
type SubMarkPointerHit = (clientX: number, clientY: number) => boolean;

let subMarkPointerHit: SubMarkPointerHit | null = null;

export function setSubMarkPointerHit(handler: SubMarkPointerHit | null): void {
  subMarkPointerHit = handler;
}

/** True when the pointer is inside the armed sub-mark (bands / grips / pad). */
export function pointerInSubMark(clientX: number, clientY: number): boolean {
  return subMarkPointerHit?.(clientX, clientY) ?? false;
}

let subMarkDragLive = false;

/** Underline/highlight drag in progress — Board must not pan this finger. */
export function setSubMarkDragLive(live: boolean): void {
  subMarkDragLive = live;
}

export function isSubMarkDragLive(): boolean {
  return subMarkDragLive;
}
