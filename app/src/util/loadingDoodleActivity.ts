/**
 * Loading doodles and notebook restore share the UI thread. A restore slice is
 * allowed to yield for a frame while somebody is actively writing on the
 * overlay; readiness still waits for the same restore to finish.
 */

const activeDoodles = new Set<object>();
const idleWaiters = new Set<() => void>();

export function beginLoadingDoodle(token: object): void {
  activeDoodles.add(token);
}

export function endLoadingDoodle(token: object): void {
  activeDoodles.delete(token);
  if (activeDoodles.size === 0) {
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }
}

/** Keep the loading surface mounted until its captured stroke is complete. */
export function waitForLoadingDoodleIdle(): Promise<void> {
  if (!isLoadingDoodleActive()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

export function isLoadingDoodleActive(): boolean {
  return activeDoodles.size > 0;
}
