/**
 * Document motion (camera pan or nested codeblock scroll), visible to work
 * that must not run mid-gesture.
 *
 * Board pulses this. Pad sync reads it and skips the tick — it does not wait
 * in a timer loop, which woke the main thread every 16–50ms during a flick.
 */

let busyUntil = 0;

const HOLD_MS = 180;

function nowMs(): number {
  return Date.now();
}

export function noteCameraBusy(): void {
  busyUntil = Math.max(busyUntil, nowMs() + HOLD_MS);
}

export function isCameraBusy(): boolean {
  return nowMs() < busyUntil;
}

export function resetCameraBusyForTests(): void {
  busyUntil = 0;
}

export function yieldToIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 800 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
