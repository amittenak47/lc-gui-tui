/**
 * Document motion (camera pan or nested codeblock scroll), visible to work
 * that must not run mid-gesture.
 *
 * Board pulses this. Pad sync and PDF text extraction read it and skip the
 * tick — they do not wait in a 16ms loop, which woke the main thread during a
 * flick. 180ms was too short: a finger that stopped and started again met a
 * hub ping (or pdf.js getTextContent) that had already begun.
 */

let busyUntil = 0;

/** Quiet window after the last camera pulse before background work may run. */
export const CAMERA_BUSY_HOLD_MS = 900;

function nowMs(): number {
  return Date.now();
}

export function noteCameraBusy(): void {
  busyUntil = Math.max(busyUntil, nowMs() + CAMERA_BUSY_HOLD_MS);
}

export function isCameraBusy(): boolean {
  return nowMs() < busyUntil;
}

export function resetCameraBusyForTests(): void {
  busyUntil = 0;
}

/** Pause until the camera has been still for {@link CAMERA_BUSY_HOLD_MS}. */
export function waitWhileCameraBusy(): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (!isCameraBusy()) {
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
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
