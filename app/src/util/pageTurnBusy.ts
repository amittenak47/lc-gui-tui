/**
 * Pages being turned, visible to background work that should wait for the
 * hand to rest — saving ink tiles, for one. Not the camera's busy signal:
 * that also holds back painting the PDF pages a hand flicking through is
 * about to reach.
 */

/** A hand flicking through comes back within this long of its last turn. */
const PAGE_TURN_HOLD_MS = 1200;
/**
 * The page a turn landed on is painted sharp once the hand has been still
 * this long. A further flick cancels a sharp paint in flight, so this need
 * not wait out a whole flick-through as the background work does: waiting
 * 1.2 s left a landed page on its blurry preview for over a second.
 */
const PAGE_TURN_PAINT_HOLD_MS = 400;

let busyUntil = 0;
const scopes = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> | undefined; listeners: Set<(busy: boolean) => void> }>();

export function notePageTurn(scope?: string): void {
  busyUntil = Math.max(busyUntil, performance.now() + PAGE_TURN_HOLD_MS);
  if (!scope) return;
  const state = scopes.get(scope);
  if (!state) return;
  const wasBusy = performance.now() < state.until;
  state.until = performance.now() + PAGE_TURN_PAINT_HOLD_MS;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.until = 0;
    for (const listener of state.listeners) listener(false);
  }, PAGE_TURN_PAINT_HOLD_MS);
  if (!wasBusy) for (const listener of state.listeners) listener(true);
}

export function isPageTurnBusy(scope?: string): boolean {
  return performance.now() < (scope ? scopes.get(scope)?.until ?? 0 : busyUntil);
}

/** How long until a hand flicking through has been still for `PAGE_TURN_HOLD_MS`. */
export function pageTurnHoldLeft(): number {
  return Math.max(0, busyUntil - performance.now());
}

/** Scope the render pause to this PDF; previews remain available during it. */
export function subscribePageTurnBusy(scope: string, listener: (busy: boolean) => void): () => void {
  let state = scopes.get(scope);
  if (!state) {
    state = { until: 0, timer: undefined, listeners: new Set() };
    scopes.set(scope, state);
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size) {
      clearTimeout(state.timer);
      scopes.delete(scope);
    }
  };
}
