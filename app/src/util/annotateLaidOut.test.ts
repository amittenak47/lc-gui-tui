import { afterEach, describe, expect, it, vi } from "vitest";

import { annotateHeightIsSettled, waitForAnnotateLaidOut } from "./annotateLaidOut";

describe("annotateHeightIsSettled", () => {
  it("treats null and negatives as silence", () => {
    expect(annotateHeightIsSettled(null, true)).toBe(false);
    expect(annotateHeightIsSettled(Number.NaN, true)).toBe(false);
    expect(annotateHeightIsSettled(-1, true)).toBe(false);
  });

  it("lets an empty note settle at zero", () => {
    expect(annotateHeightIsSettled(0, true)).toBe(true);
  });

  it("does not treat zero as laid out when the file has content", () => {
    expect(annotateHeightIsSettled(0, false)).toBe(false);
    expect(annotateHeightIsSettled(9000, false)).toBe(true);
  });
});

describe("waitForAnnotateLaidOut", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not resolve on a sticky zero while the file has content", async () => {
    expect(await waitForAnnotateLaidOut(() => 0, 80, false)).toBe(false);
  });

  it("resolves once a real height is stable", async () => {
    let height: number | null = 0;
    const pending = waitForAnnotateLaidOut(() => height, 400, false);
    height = 9000;
    expect(await pending).toBe(true);
  });

  it("resolves on elapsed stability even when polls are sparse", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms) => {
      return realSetTimeout(handler as TimerHandler, Math.max(Number(ms) || 0, 200));
    });
    expect(await waitForAnnotateLaidOut(() => 9000, 2000, false)).toBe(true);
  });

  it("resets the deadline while height is still growing", async () => {
    let height = 1000;
    const pending = waitForAnnotateLaidOut(() => height, 300, false);
    globalThis.setTimeout(() => {
      height = 4000;
    }, 80);
    globalThis.setTimeout(() => {
      height = 8000;
    }, 160);
    expect(await pending).toBe(true);
  });
});
