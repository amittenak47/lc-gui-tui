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
/** Epoch ms when canvas zeroing / delayed commit may run. 0 = never pulsed. */
let idleTeardownAt = 0;

/** Quiet window after the last camera pulse on desktop / browser. */
export const CAMERA_BUSY_HOLD_MS_DESKTOP = 180;
/** Quiet window on Android WebView — long enough that a second flick wins. */
export const CAMERA_BUSY_HOLD_MS_ANDROID = 900;
/**
 * Pulse timeout on desktop: PDF pump may paint neighbours. Not pageOut, not
 * Excalidraw commit, not ink moving-mode drop.
 */
export const CAMERA_PULSE_SETTLE_MS = 140;
/**
 * After the last pan sample, wait this long before tearing down GPU canvases
 * or committing the live camera. Must outlast a 3–5s reading pause; 3s was
 * short enough that the next burst met a dead layer stack.
 */
export const CAMERA_IDLE_TEARDOWN_MS = 15_000;

export function cameraBusyHoldMs(): number {
  return isAndroidDevice() ? CAMERA_BUSY_HOLD_MS_ANDROID : CAMERA_BUSY_HOLD_MS_DESKTOP;
}

/**
 * How long `setDocCameraLive` stays true after the last sample.
 *
 * 140ms lets neighbour paint sneak in between strong flicks (finger up ~200–
 * 500ms). Android uses the same 900ms window as {@link cameraBusyHoldMs} so
 * a same-direction burst stays frozen until it actually stops.
 */
export function cameraPulseSettleMs(): number {
  return isAndroidDevice() ? CAMERA_BUSY_HOLD_MS_ANDROID : CAMERA_PULSE_SETTLE_MS;
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
  idleTeardownAt = 0;
}

/** Board calls this on every pan/wheel sample so PDF pageOut shares the idle clock. */
export function noteCameraIdlePulse(): void {
  idleTeardownAt = nowMs() + CAMERA_IDLE_TEARDOWN_MS;
}

export function isCameraIdleForTeardown(): boolean {
  return nowMs() >= idleTeardownAt;
}

export function msUntilCameraIdleTeardown(): number {
  return Math.max(0, idleTeardownAt - nowMs());
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

/**
 * One macrotask so a queued pointerdown can freeze the PDF pump before the
 * next `toBlob` / `page.render`. Not `requestIdleCallback` — that waits for
 * quiet, which is the opposite of interrupt.
 */
export function yieldToInput(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
