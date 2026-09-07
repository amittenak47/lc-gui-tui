/**
 * Board host live-stroke contract (plan B).
 *
 * Replay is for lift / camera. The nib rAF keeps one snap and a frozen
 * backing store until the pointer comes up. Shrinking to a 1:1 canvas here
 * would mix overdrawn overlay spines with live bitmap space — that clip is
 * plan C.
 */

export function skipCommittedReplay(
  drawing: boolean,
  liveStamp: unknown | null | undefined,
): boolean {
  return drawing && liveStamp == null;
}
