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
 * Hold-open of the nib wheel aborts the live stroke. The committed snap still
 * has the page. Replaying every overlay spine on that timer ANRs a tablet
 * sitting on a dense notebook.
 */
export function skipReplayOnWheelAbort(): boolean {
  return true;
}

/**
 * Camera rebase must land in one present. A backing-store resize already wiped
 * the bitmap — slice the remesh so the sizeToHost path cannot ANR Android.
 */
export function instantReplayOnBackingResize(): boolean {
  return false;
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
export const LIVE_HUD_FLUSH_MS = 48;

export function shouldFlushLiveHud(
  lastAt: number,
  now: number,
  live: boolean,
): boolean {
  if (!live) return true;
  return !(lastAt > 0) || now - lastAt >= LIVE_HUD_FLUSH_MS;
}
