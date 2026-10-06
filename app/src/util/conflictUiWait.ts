export const CONFLICT_UI_MOUNT_MS = 3_000;

export interface ConflictUiLifecycle {
  signal: AbortSignal;
  onMounted(): void;
  onUnavailable(): void;
}

/** Time-limit mounting, not the reader's decision after the window appears. */
export function waitForConflictUi<T>(
  show: ((lifecycle: ConflictUiLifecycle) => Promise<T>) | undefined,
  signal: AbortSignal,
  reason: string,
): Promise<T> {
  const ui = new AbortController();
  let mounted = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let stop = () => {};
  return new Promise<T>((resolve, reject) => {
    const finish = (cause?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      ui.abort();
      if (cause) reject(cause);
      else resolve(result!);
    };
    stop = () => finish(new Error("Sync stopped. Tap Sync to retry."));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => {
      if (!mounted) finish(new Error(reason));
    }, CONFLICT_UI_MOUNT_MS);
    if (!show) { finish(new Error(reason)); return; }
    try {
      Promise.resolve(show({
        signal: ui.signal,
        onMounted: () => { mounted = true; clearTimeout(timer); },
        onUnavailable: () => finish(new Error(reason)),
      })).then((value) => {
        if (value == null) finish(new Error(reason));
        else finish(undefined, value);
      }, (cause) => finish(cause));
    } catch (cause) { finish(cause); }
  });
}

/** Preview preparation must not hide a conflict before the mount watchdog starts. */
export function prepareConflictUi<T>(work: Promise<T>, signal: AbortSignal, reason: string): Promise<T> {
  return waitForConflictUi(() => work, signal, reason);
}
