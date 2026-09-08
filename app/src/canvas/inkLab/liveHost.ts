/**
 * Board host live-stroke contract (plans B–E).
 *
 * Replay is for lift / camera. The nib rAF keeps one snap and a frozen
 * backing store until the pointer comes up. Plan C clips the live snap+SDF
 * blit to the dirty AABB; do not shrink the overlay canvas on pointer down.
 * Plan E presents every vsync while the nib is down — pointermove only
 * ingests. Scheduling paint from move made the HUD rAF track the tablet's
 * coalesced move rate instead of the display.
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
