/**
 * One job at a time, per name.
 *
 * A webview label is a single global name, so overlapping work on one is not
 * slow — it is "a webview with label ... already exists", and worse, whichever
 * job finishes first tears the other's view down: an offscreen render killed
 * mid-serialise, or the page you were reading closed underneath you.
 *
 * Callers overlap without meaning to. React runs an effect's cleanup and its
 * replacement back to back, and a cleanup that closes a webview is a promise
 * nobody awaits — so the close for the address you left and the open for the
 * one you arrived at are genuinely in flight together. Typing a new address
 * mid-load does the same.
 *
 * Queueing per name is the fix. The alternative is every call site remembering,
 * and the one that forgets is the one that shows a red banner.
 */

const queues = new Map<string, Promise<unknown>>();

export function queued<T>(name: string, job: () => Promise<T>): Promise<T> {
  const prior = queues.get(name) ?? Promise.resolve();
  // Run the job on both settle paths: a rejection must not wedge the name.
  const run = prior.then(job, job);
  queues.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}

/** Test seam — forget every chain. */
export function resetLabelQueues(): void {
  queues.clear();
}
