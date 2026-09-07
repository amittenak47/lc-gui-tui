/**
 * Board host live-stroke contract (plan B).
 *
 * Replay is for lift / camera. The nib rAF keeps one snap and a frozen
 * backing store until the pointer comes up. Plan C clips the live snap+SDF
 * blit to the dirty AABB; do not shrink the overlay canvas on pointer down.
 */

export function skipCommittedReplay(
  drawing: boolean,
  liveStamp: unknown | null | undefined,
): boolean {
  return drawing && liveStamp == null;
}
