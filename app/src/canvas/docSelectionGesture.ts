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
const claimedHandlers = new Set<() => void>();

export type DocScrollShare = {
  /** True when this surface owns the selection that is asking. */
  owns: (origin: Node | null) => boolean;
  move: (dy: number) => number;
};

const scrollShares = new Set<DocScrollShare>();

type SubMarkPointerHit = (clientX: number, clientY: number) => boolean;

const subMarkHits = new Set<SubMarkPointerHit>();

/*
 * Counted, not set.
 *
 * "The camera is live" was one boolean for the whole process, which was true
 * while exactly one surface could be scrolled. The conflict split mounts two
 * `ConflictPagePreview`s side by side over a reader that is still subscribed,
 * and there `setDocCameraLive(false)` does not mean "this pane settled" — it
 * means "nothing anywhere is moving", which is a claim one pane cannot make.
 * Flicking Local froze the Server pane's paint pump, and a pointer-up on
 * either one released the other's finger.
 *
 * So each surface takes a share and the flag is the sum. Still module scope
 * rather than a React context: the gatekeeper runs inside a native listener
 * installed once, and a context value read at render time would be a frame
 * stale exactly when it matters.
 */
let cameraLiveCount = 0;
let pointerHeldCount = 0;
let cameraLive = false;
let pointerHeld = false;
let publishedFrozen = false;
const cameraLiveListeners = new Set<(live: boolean) => void>();
let legacyCameraLiveUnsub: (() => void) | null = null;

/** `document.documentElement` while the reading camera is mid-gesture. */
export const DOC_CAMERA_LIVE_CLASS = "lc-doc-camera-live";

function paintFrozen(): boolean {
  return cameraLive || pointerHeld;
}

function syncCameraLiveClass(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(DOC_CAMERA_LIVE_CLASS, cameraLive);
}

function publishPaintFrozen(): void {
  const next = paintFrozen();
  if (next === publishedFrozen) return;
  publishedFrozen = next;
  for (const listener of [...cameraLiveListeners]) listener(next);
}

/**
 * Board registers here so a mid-gesture claim can drop a deferred pan /
 * side-scroll that armed from the same finger before the hold landed.
 *
 * A set, not a slot: two Boards both register, and unmount of one must not
 * drop the other's handler.
 */
export function onSelectionGestureClaimed(handler: (() => void) | null): () => void {
  if (!handler) return () => {};
  claimedHandlers.add(handler);
  return () => {
    claimedHandlers.delete(handler);
  };
}

/** The selection has taken this gesture — Board must not pan on it. */
export function claimSelectionGesture(): void {
  claimed = true;
  noteCameraBusy();
  for (const handler of claimedHandlers) handler();
}

/** Hand the pointer back, on lift or when the hold is abandoned. */
export function releaseSelectionGesture(): void {
  claimed = false;
}

export function selectionOwnsGesture(): boolean {
  return claimed;
}

/**
 * Take or drop one share of "a reading camera is mid-gesture (pulse / coast)".
 *
 * Clamped at zero so a stray release — a teardown that lowers a flag it never
 * raised — cannot push the count negative and leave the next real gesture
 * unable to reach one. Prefer {@link makeDocFlagHolds} over calling this
 * directly: a share has to be paired to be counted, and the call sites that
 * pulse on every scroll event are not naturally paired.
 */
export function setDocCameraLive(live: boolean): void {
  cameraLiveCount = Math.max(0, cameraLiveCount + (live ? 1 : -1));
  const next = cameraLiveCount > 0;
  if (cameraLive === next) return;
  cameraLive = next;
  syncCameraLiveClass();
  publishPaintFrozen();
}

/**
 * Finger is down on the reading surface, even before pan has armed.
 *
 * Selectable docs wait 16px of travel before the first camera sample. Idle
 * `toBlob` / `page.render` used that gap (and the time until
 * `pulseCameraMotion`) to keep the main thread busy — the gesture registered,
 * the page did not move. Freeze the paint pump at pointerdown instead.
 *
 * Counted and clamped like {@link setDocCameraLive}, and for the same reason:
 * two fingers on two panes are two holds, and the first one up is not the end
 * of the gesture.
 */
export function setDocPointerHeld(held: boolean): void {
  pointerHeldCount = Math.max(0, pointerHeldCount + (held ? 1 : -1));
  const next = pointerHeldCount > 0;
  if (pointerHeld === next) return;
  pointerHeld = next;
  publishPaintFrozen();
}

/** One caller's share of the two flags above — see {@link makeDocFlagHolds}. */
export type DocFlagHolds = {
  /** This surface's camera is pulsing / coasting. */
  camera(live: boolean): void;
  /** A finger is down on this surface. */
  pointer(held: boolean): void;
};

/**
 * A latched share of the module flags, for one surface.
 *
 * The counts above are only honest if every caller pairs its own raise with
 * its own release, and the call sites do not: a scroll pulse raises `camera`
 * on every event it sees, and a teardown lowers `pointer` whether or not that
 * surface ever had a finger on it. Latching makes both harmless — a repeated
 * raise is still one share, and a release from a surface holding nothing is
 * nothing at all.
 *
 * One per Board and one per conflict pane, kept for the life of the surface.
 */
export function makeDocFlagHolds(): DocFlagHolds {
  let camera = false;
  let pointer = false;
  return {
    camera(live: boolean): void {
      if (camera === live) return;
      camera = live;
      setDocCameraLive(live);
    },
    pointer(held: boolean): void {
      if (pointer === held) return;
      pointer = held;
      setDocPointerHeld(held);
    },
  };
}

/** Drop every share, for tests that do not tear their surfaces down. */
export function resetDocCameraForTests(): void {
  cameraLiveCount = 0;
  pointerHeldCount = 0;
  if (cameraLive) {
    cameraLive = false;
    syncCameraLiveClass();
  }
  pointerHeld = false;
  claimedHandlers.clear();
  scrollShares.clear();
  subMarkHits.clear();
  publishPaintFrozen();
}

export function isDocCameraLive(): boolean {
  return paintFrozen();
}

/**
 * Subscribe to camera live edges.
 *
 * More than one listener: footnote ribbons *and* the PDF paint pump both have
 * to freeze for the same flick, and a single-slot setter would drop the other.
 */
export function subscribeDocCameraLive(handler: (live: boolean) => void): () => void {
  cameraLiveListeners.add(handler);
  return () => {
    cameraLiveListeners.delete(handler);
  };
}

/** DocSelectionLayer flushes deferred ribbon placement when live goes false. */
export function onDocCameraLiveChange(handler: ((live: boolean) => void) | null): void {
  legacyCameraLiveUnsub?.();
  legacyCameraLiveUnsub = null;
  if (handler) legacyCameraLiveUnsub = subscribeDocCameraLive(handler);
}

/* ----------------------------------------------------- edge auto-scroll --- */

/**
 * Board offers the reading camera a nudge, for a selection dragged off the edge.
 *
 * A set, not a slot: two panes both register, and unmount of one must not
 * drop the other's camera. {@link requestDocScroll} asks the surface that
 * owns the origin first.
 */
export function onDocScrollRequest(
  handler: DocScrollShare | ((dy: number) => number) | null,
): () => void {
  if (!handler) return () => {};
  const share: DocScrollShare =
    typeof handler === "function" ? { owns: () => true, move: handler } : handler;
  scrollShares.add(share);
  return () => {
    scrollShares.delete(share);
  };
}

/** Ask for `dy` pixels of page scroll. Returns what was granted. */
export function requestDocScroll(dy: number, origin?: Node | null): number {
  if (origin) {
    for (const share of scrollShares) {
      if (!share.owns(origin)) continue;
      const moved = share.move(dy);
      if (moved !== 0) return moved;
    }
  }
  for (const share of scrollShares) {
    const moved = share.move(dy);
    if (moved !== 0) return moved;
  }
  return 0;
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
export function setSubMarkPointerHit(handler: SubMarkPointerHit | null): () => void {
  if (!handler) return () => {};
  subMarkHits.add(handler);
  return () => {
    subMarkHits.delete(handler);
  };
}

/** True when the pointer is inside the armed sub-mark (bands / grips / pad). */
export function pointerInSubMark(clientX: number, clientY: number): boolean {
  for (const hit of subMarkHits) {
    if (hit(clientX, clientY)) return true;
  }
  return false;
}

let subMarkDragLive = false;

/** Underline/highlight drag in progress — Board must not pan this finger. */
export function setSubMarkDragLive(live: boolean): void {
  subMarkDragLive = live;
}

export function isSubMarkDragLive(): boolean {
  return subMarkDragLive;
}
