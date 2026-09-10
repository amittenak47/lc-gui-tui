/**
 * Loading doodles and notebook restore share the UI thread. A restore slice is
 * allowed to yield for a frame while somebody is actively writing on the
 * overlay; readiness still waits for the same restore to finish.
 */

const activeDoodles = new Set<object>();

export function beginLoadingDoodle(token: object): void {
  activeDoodles.add(token);
}

export function endLoadingDoodle(token: object): void {
  activeDoodles.delete(token);
}

export function isLoadingDoodleActive(): boolean {
  return activeDoodles.size > 0;
}
