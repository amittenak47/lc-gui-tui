import { afterEach, describe, expect, it, vi } from "vitest";

import { isCameraBusy, noteCameraBusy, resetCameraBusyForTests } from "./cameraBusy";

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
    vi.advanceTimersByTime(200);
    expect(isCameraBusy()).toBe(false);
  });
});
