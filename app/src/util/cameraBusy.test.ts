import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_BUSY_HOLD_MS,
  isCameraBusy,
  noteCameraBusy,
  resetCameraBusyForTests,
  waitWhileCameraBusy,
} from "./cameraBusy";

afterEach(() => {
  resetCameraBusyForTests();
  vi.useRealTimers();
});

describe("cameraBusy", () => {
  it("is idle until the camera pulses", () => {
    expect(isCameraBusy()).toBe(false);
    noteCameraBusy();
    expect(isCameraBusy()).toBe(true);
  });

  it("clears after the hold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    noteCameraBusy();
    expect(isCameraBusy()).toBe(true);
    vi.advanceTimersByTime(CAMERA_BUSY_HOLD_MS - 1);
    expect(isCameraBusy()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isCameraBusy()).toBe(false);
  });

  it("waitWhileCameraBusy resolves once the hold ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    noteCameraBusy();
    const pending = waitWhileCameraBusy();
    await vi.advanceTimersByTimeAsync(CAMERA_BUSY_HOLD_MS + 80);
    await pending;
    expect(isCameraBusy()).toBe(false);
  });
});
