import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_BUSY_HOLD_MS_ANDROID,
  CAMERA_BUSY_HOLD_MS_DESKTOP,
  CAMERA_IDLE_TEARDOWN_MS,
  CAMERA_PULSE_SETTLE_MS,
  cameraBusyHoldMs,
  cameraPulseSettleMs,
  isCameraBusy,
  isCameraIdleForTeardown,
  msUntilCameraIdleTeardown,
  noteCameraBusy,
  noteCameraIdlePulse,
  resetCameraBusyForTests,
  waitWhileCameraBusy,
  yieldToInput,
} from "./cameraBusy";

afterEach(() => {
  resetCameraBusyForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cameraBusy", () => {
  it("is idle until the camera pulses", () => {
    expect(isCameraBusy()).toBe(false);
    noteCameraBusy();
    expect(isCameraBusy()).toBe(true);
  });

  it("clears after the desktop hold when the UA is not Android", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(cameraBusyHoldMs()).toBe(CAMERA_BUSY_HOLD_MS_DESKTOP);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    noteCameraBusy();
    expect(isCameraBusy()).toBe(true);
    vi.advanceTimersByTime(CAMERA_BUSY_HOLD_MS_DESKTOP - 1);
    expect(isCameraBusy()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isCameraBusy()).toBe(false);
  });

  it("holds longer on an Android UA", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    expect(cameraBusyHoldMs()).toBe(CAMERA_BUSY_HOLD_MS_ANDROID);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    noteCameraBusy();
    vi.advanceTimersByTime(CAMERA_BUSY_HOLD_MS_DESKTOP + 1);
    expect(isCameraBusy()).toBe(true);
    vi.advanceTimersByTime(CAMERA_BUSY_HOLD_MS_ANDROID - CAMERA_BUSY_HOLD_MS_DESKTOP);
    expect(isCameraBusy()).toBe(false);
  });

  it("waitWhileCameraBusy resolves once the hold ends", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    noteCameraBusy();
    const pending = waitWhileCameraBusy();
    await vi.advanceTimersByTimeAsync(cameraBusyHoldMs() + 80);
    await pending;
    expect(isCameraBusy()).toBe(false);
  });

  it("yieldToInput resolves on the next macrotask", async () => {
    let turned = false;
    const pending = yieldToInput().then(() => {
      expect(turned).toBe(true);
    });
    turned = true;
    await pending;
  });

  it("desktop pulse settle is 140ms and page-out idle is 15s", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(cameraPulseSettleMs()).toBe(CAMERA_PULSE_SETTLE_MS);
    expect(CAMERA_PULSE_SETTLE_MS).toBe(140);
    expect(CAMERA_IDLE_TEARDOWN_MS).toBe(15_000);
  });

  it("Android pulse settle matches the 900ms busy hold", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    expect(cameraPulseSettleMs()).toBe(CAMERA_BUSY_HOLD_MS_ANDROID);
  });

  it("holds page-out until 15s after the last idle pulse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    expect(isCameraIdleForTeardown()).toBe(true);
    noteCameraIdlePulse();
    expect(isCameraIdleForTeardown()).toBe(false);
    expect(msUntilCameraIdleTeardown()).toBe(CAMERA_IDLE_TEARDOWN_MS);
    vi.advanceTimersByTime(CAMERA_IDLE_TEARDOWN_MS - 1);
    expect(isCameraIdleForTeardown()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(isCameraIdleForTeardown()).toBe(true);
  });
});
