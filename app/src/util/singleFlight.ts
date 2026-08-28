/**
 * Run one copy of an async job at a time; overlapping callers share the answer.
 *
 * The shape this exists for: several unrelated events all want the same
 * question asked. Focus, `visibilitychange` and a poll timer each wanted the
 * LLM's status, each started its own request, and — worse — each started its
 * own follow-up timer when that request came back. Two events close together
 * left two polling chains behind one timer handle, so only the newest could
 * ever be cleared and the rest kept asking for the life of the session.
 *
 * Callers that arrive while a run is in flight get that run's promise rather
 * than a second request. Once it settles the slot is free again, so this
 * coalesces concurrent callers without caching the result.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const started = run();
    inFlight = started;
    /*
     * Clear only if this run is still the current one. A `finally` resolves a
     * microtask after the caller's own handlers, and a caller is entitled to
     * start the next run from one of those — clearing unconditionally would
     * then throw away a run that had already begun.
     */
    void started.then(
      () => {
        if (inFlight === started) inFlight = null;
      },
      () => {
        if (inFlight === started) inFlight = null;
      },
    );
    return started;
  };
}
