/**
 * Document motion (camera pan or nested codeblock scroll), visible to work
 * that must not run mid-gesture.
 *
 * Board pulses this. Pad sync and PDF text extraction read it and skip the
 * tick — they do not wait in a 16ms loop, which woke the main thread during a
 * flick. On Android, 180ms was too short: a finger that stopped and started
 * again met a hub ping (or pdf.js getTextContent) that had already begun.
 * Desktop mouse pan keeps the original 180ms quiet window.
 */

import { isAndroidDevice } from "./androidDevice";

let busyUntil = 0;

/** Quiet window after the last camera pulse on desktop / browser. */
export const CAMERA_BUSY_HOLD_MS_DESKTOP = 180;
/** Quiet window on Android WebView — long enough that a second flick wins. */
export const CAMERA_BUSY_HOLD_MS_ANDROID = 900;

export function cameraBusyHoldMs(): number {
  return isAndroidDevice() ? CAMERA_BUSY_HOLD_MS_ANDROID : CAMERA_BUSY_HOLD_MS_DESKTOP;
}

function nowMs(): number {
  return Date.now();
}

export function noteCameraBusy(): void {
  busyUntil = Math.max(busyUntil, nowMs() + cameraBusyHoldMs());
}

export function isCameraBusy(): boolean {
  return nowMs() < busyUntil;
}

export function resetCameraBusyForTests(): void {
  busyUntil = 0;
}

/** Pause until the camera has been still for {@link cameraBusyHoldMs}. */
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
