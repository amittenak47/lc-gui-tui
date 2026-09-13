/**
 * Board host live-stroke contract (plans B–E).
 *
 * Replay is for lift / camera. The nib rAF keeps one snap and a frozen
 * backing store until the pointer comes up. Plan C clips the live snap+SDF
 * blit to the dirty AABB; do not shrink the overlay canvas on pointer down.
 * Plan E keeps the rAF pump armed while the nib is down — pointermove only
 * ingests. Empty vsyncs skip GPU present; 90Hz+ caps composites at 60fps
 * unless Match display is on. While Writing only erases and blits the
 * live-smooth tail; frozen ink stays in the SDF and on the host.
 * Scheduling paint from move made the HUD rAF track the tablet's coalesced
 * move rate instead of the display.
 */

export function skipCommittedReplay(
  drawing: boolean,
  liveStamp: unknown | null | undefined,
): boolean {
  return drawing && liveStamp == null;
}

/**
 * Assigning `canvas.width` / `height` clears the bitmap even when the numbers
 * already match. A CSS `top` mismatch is only the overdraw park — remesh when
 * the backing store actually changed.
 */
export function inkCanvasPixelsChanged(
  canvas: { width: number; height: number },
  pixelW: number,
  pixelH: number,
): boolean {
  return canvas.width !== pixelW || canvas.height !== pixelH;
}

/**
 * Assigning `canvas.style.width/height/top` on every letter dirties layout
 * even when the strings already match. The next `getBoundingClientRect` on
 * nested hosts then walks the whole KaTeX tree.
 */
export function inkCanvasCssMatches(
  canvas: { style: { width: string; height: string; top: string; left: string } },
  cssW: number,
  cssH: number,
  top: string,
): boolean {
  return (
    canvas.style.width === `${cssW}px` &&
    canvas.style.height === `${cssH}px` &&
    canvas.style.top === top &&
    canvas.style.left === "0px"
  );
}

/**
 * After aborting remesh to take a letter, do not rebuild on that letter's lift.
 * Lift-stack remesh (`collectScrollHosts` + tiles) occupies the main thread,
 * so the next pointerdown sits in the queue — the blank gap before "th".
 * Wait until the pen has been up this long.
 */
export function idleRemeshAfterStrokeMs(): number {
  return 400;
}

/**
 * Host-bound pen is still a pen. Lift already AABB-patched the letter onto
 * the snap. `presentCommitted(null, true)` on that stack remeshed the whole
 * notebook synchronously — frozen page, no ANR, ink appears after Home
 * (Massive_Lag). Nested-scroll remesh stays on the host-scroll observer.
 */
export function remeshOnHostBoundLift(): boolean {
  return false;
}

/**
 * Hold-open of the nib wheel aborts the live stroke. The committed snap still
 * has the page. Replaying every overlay spine on that timer ANRs a tablet
 * sitting on a dense notebook.
 */
export function skipReplayOnWheelAbort(): boolean {
  return true;
}

/**
 * Interactive resize is a camera rebase and lands in one present. During
 * loading the opaque overlay owns first paint, so a dense restore may prepare
 * the wiped backing store in slices without exposing partial ink.
 */
export function instantReplayOnBackingResize(preparing = false): boolean {
  return !preparing;
}

/**
 * LRU hydrate is not a camera rebase. Instant overlay rebuild on that path
 * is the "Whiteboard isn't responding" dialog on a dense Exam page.
 */
export function instantReplayOnPageWindow(): boolean {
  return false;
}

/**
 * First present after restore (loading overlay still up, or just dropping)
 * must not remesh every overlay spine on one tick. Slice it like a resize.
 */
export function instantReplayOnFirstPresent(): boolean {
  return false;
}

/**
 * Pointer-down used to cancel a sliced remesh and replay every overlay spine
 * on the nib stack — "Whiteboard isn't responding" plus a growing clip square.
 */
export function instantReplayOnPointerDown(): boolean {
  return false;
}

/**
 * An in-flight sliced remesh must not blit onto the host after the nib is down.
 * That wipe is the growing clip square. Abort the gen; do not finish the step.
 */
export function finishReplayWhileDrawing(): boolean {
  return false;
}

/**
 * Undo/redo without a pixel patch must not remesh every overlay spine on the
 * click stack. That is the Close App / Wait dialog on a dense Exam page.
 */
export function instantReplayOnUndo(): boolean {
  return false;
}

/**
 * Pan slides the snap and never enters this path. A real zoom/resize rebase is
 * still one atomic present: slicing it is the blank page / crawling-spines
 * regression. Camera is a correctness constraint, not a replay budget.
 */
export function instantReplayOnCameraRebase(): boolean {
  return true;
}

/**
 * Nested `pre.scrollLeft` must not remesh tiles. Host-bound ink is not in the
 * tile cache; restamp it from the last page-only blit. Full `presentCommitted`
 * on every sample is the 5–30fps fence and the frozen overlay (HTML moves,
 * AABB pixels stay).
 */
export function remeshOnNestedHostScroll(): boolean {
  return false;
}

/**
 * Android holds `isCameraBusy` for 900ms after a flick. Skipping the host-bound
 * restamp in that window is ink gone until the fence is touched.
 */
export function skipHostBoundPresentWhileCameraBusy(): boolean {
  return false;
}

/**
 * Page pan already CSS-translates the snap with the `<pre>`. Restamping during
 * that ride paints live-camera host-bound onto an old-camera bitmap.
 */
export function skipHostBoundPresentWhilePagePan(): boolean {
  return true;
}

/** Cached page blit is reusable only at the same backing-store size. */
export function pageStageMatchesCanvas(
  page: { width: number; height: number } | null | undefined,
  canvas: { width: number; height: number },
): boolean {
  return page != null && page.width === canvas.width && page.height === canvas.height;
}

/** Pan settle must not remesh. Slide the committed snap; fill the new strip. */
export function shiftSnapOnCameraRebase(): boolean {
  return true;
}

/**
 * Picking eraser / pen / highlighter is not a pan settle. `setCameraMoving(false)`
 * used to remesh every overlay spine on that tap.
 */
export function remeshOnCameraMovingEnd(wasMoving: boolean): boolean {
  return wasMoving;
}

/**
 * HUD / load-bar text lives under the ink host. Nested-scroll observers must
 * not treat those writes as a new `<pre>` scroller.
 */
export function mutationIsInkChrome(
  records: readonly { target: Node }[],
  inkHost: Node | null,
): boolean {
  if (!inkHost || records.length === 0) return false;
  return records.every((record) => inkHost.contains(record.target));
}

/**
 * Live highlighter already has the pre-stroke snap. Restoring that and
 * stamping the live op is enough — replaying every pen would hitch.
 */
export function usePreStrokeStamp(
  liveStamp: unknown | null | undefined,
  hasPreStrokePatch: boolean,
): boolean {
  return liveStamp != null && hasPreStrokePatch;
}

export type PaintedLabView = {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
  marginY: number;
};

export function samePaintedView(
  a: PaintedLabView | null,
  b: Pick<PaintedLabView, "scrollX" | "scrollY" | "zoom" | "width" | "height" | "marginY">,
): boolean {
  if (!a) return false;
  return (
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.zoom === b.zoom &&
    a.width === b.width &&
    a.height === b.height &&
    a.marginY === b.marginY
  );
}

/**
 * Keep the overlay rAF running for the whole stroke, not only blot-hold
 * ticks. A still plateau must not be the thing that stops the pump: the
 * next hop still needs a vsync callback already queued, or a busy board
 * waits for the next pointermove (~25–100ms) to present.
 */
export function keepLivePaintPump(drawing: boolean): boolean {
  return drawing;
}

/**
 * Overlay text/spark at most this often while the nib is down. Min/max/avg
 * still sample every paint. Writing a `<pre>` every vsync on the board is
 * enough layout to miss the next frame (16.7 then 33.3 → ~25ms avg).
 */
export const LIVE_HUD_FLUSH_MS = 200;

export function shouldFlushLiveHud(
  lastAt: number,
  now: number,
  live: boolean,
): boolean {
  if (!live) return true;
  return !(lastAt > 0) || now - lastAt >= LIVE_HUD_FLUSH_MS;
}
