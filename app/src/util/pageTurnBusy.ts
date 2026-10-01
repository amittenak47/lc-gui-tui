/**
 * Pages being turned, visible to background work that should wait for the
 * hand to rest — saving ink tiles, for one. Not the camera's busy signal:
 * that also holds back painting the PDF pages a hand flicking through is
 * about to reach.
 */

/** A hand flicking through comes back within this long of its last turn. */
const PAGE_TURN_HOLD_MS = 1200;

let busyUntil = 0;

export function notePageTurn(): void {
  busyUntil = Math.max(busyUntil, performance.now() + PAGE_TURN_HOLD_MS);
}

export function isPageTurnBusy(): boolean {
  return performance.now() < busyUntil;
}
