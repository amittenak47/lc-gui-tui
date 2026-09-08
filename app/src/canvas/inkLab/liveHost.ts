/**
 * Board host live-stroke contract (plans B–E).
 *
 * Replay is for lift / camera. The nib rAF keeps one snap and a frozen
 * backing store until the pointer comes up. Plan C clips the live snap+SDF
 * blit to the dirty AABB; do not shrink the overlay canvas on pointer down.
 * Plan E keeps the rAF pump armed while the nib is down — pointermove only
 * ingests. Empty vsyncs skip GPU present; 90Hz+ caps composites at 60fps
 * unless Match display is on.
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
