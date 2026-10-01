/**
 * The launch is over: the splash has gone and the restored tab is open.
 *
 * Housekeeping that walks the whole library — trash sweeps, the attachment
 * cache's collection — used to start on mount, alongside the restore. It
 * competes for the same main thread and the same IndexedDB stores, and the
 * splash waits on the restore, so every launch paid for both. Work that can
 * wait waits for this instead.
 */

let settled = false;
const waiting = new Set<() => void>();

/** The App calls this once the boot overlay has gone. */
export function markBootSettled(): void {
  if (settled) return;
  settled = true;
  for (const resolve of waiting) resolve();
  waiting.clear();
}

export function isBootSettled(): boolean {
  return settled;
}

/**
 * Resolves once the launch is over, or after `maxWaitMs` regardless: a shell
 * that never reports (a test harness, a crashed overlay) must not hold
 * housekeeping off forever.
 */
export function afterBootSettled(maxWaitMs = 30_000): Promise<void> {
  if (settled) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      waiting.delete(done);
      resolve();
    };
    const timer = window.setTimeout(done, maxWaitMs);
    waiting.add(done);
  });
}

/** Test seam. */
export function resetBootSettledForTests(): void {
  settled = false;
  waiting.clear();
}
