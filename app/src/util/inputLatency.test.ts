import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INPUT_DELAY_BLAME_MS,
  noteReadingPointerDown,
  openBackgroundJob,
  readingLatency,
  resetInputLatencyForTests,
  summariseInputDelay,
} from "./inputLatency";

type ScrollDebugGlobal = { __LC_SCROLL_DEBUG__?: boolean };

/**
 * A clock we own.
 *
 * The real one starts near zero, so "stamped 400ms ago" is a negative
 * timestamp in the first half second of a test run — which the module is
 * right to throw away and which would make these tests pass or fail on how
 * long the suite took to get here.
 */
function fixClock(now: number): void {
  vi.spyOn(performance, "now").mockReturnValue(now);
}

/** A pointerdown the platform stamped `ago` ms before the handler ran. */
function downFrom(now: number, ago: number): { timeStamp: number } {
  fixClock(now);
  return { timeStamp: now - ago };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetInputLatencyForTests();
  delete (globalThis as ScrollDebugGlobal).__LC_SCROLL_DEBUG__;
});

describe("noteReadingPointerDown", () => {
  it("reports finger-down to handler as the delay", () => {
    expect(noteReadingPointerDown(downFrom(10_000, 300))).toBe(300);
    expect(readingLatency.samples()).toHaveLength(1);
  });

  it("ignores an event with no usable timestamp", () => {
    // jsdom and synthetic events stamp 0; an hours-long "delay" would poison
    // every number in the summary.
    fixClock(10_000);
    expect(noteReadingPointerDown({ timeStamp: 0 })).toBe(0);
    expect(noteReadingPointerDown({ timeStamp: Number.NaN })).toBe(0);
    expect(noteReadingPointerDown({ timeStamp: -1 })).toBe(0);
    expect(readingLatency.samples()).toHaveLength(0);
  });

  it("ignores a clock disagreement rather than recording it as a stall", () => {
    expect(noteReadingPointerDown(downFrom(90_000, 60_000))).toBe(0);
    expect(readingLatency.samples()).toHaveLength(0);
  });

  it("names the background jobs open when the finger landed", () => {
    (globalThis as ScrollDebugGlobal).__LC_SCROLL_DEBUG__ = true;
    fixClock(10_000);
    const close = openBackgroundJob("pdf-thumb:412");
    noteReadingPointerDown(downFrom(10_000, 400));
    close();
    noteReadingPointerDown(downFrom(11_000, 2));

    const [blocked, clean] = readingLatency.samples();
    expect(blocked?.blame).toEqual(["pdf-thumb:412"]);
    expect(clean?.blame).toEqual([]);
  });

  it("costs nothing to bracket a job while blame is off", () => {
    fixClock(10_000);
    const close = openBackgroundJob("pdf-paint:7@2");
    noteReadingPointerDown(downFrom(10_000, 400));
    close();
    expect(readingLatency.samples()[0]?.blame).toEqual([]);
  });

  it("keeps the samples a summary is taken over", () => {
    noteReadingPointerDown(downFrom(10_000, 4));
    noteReadingPointerDown(downFrom(11_000, 480));
    const summary = readingLatency.summary();
    expect(summary.count).toBe(2);
    expect(summary.maxMs).toBe(480);
    expect(summary.slow).toBe(1);
  });
});

describe("summariseInputDelay", () => {
  it("counts the samples a reader would call slow", () => {
    const summary = summariseInputDelay([
      { delayMs: 4, at: 1, blame: [], blockedMs: 0 },
      { delayMs: 8, at: 2, blame: [], blockedMs: 0 },
      { delayMs: 480, at: 3, blame: ["pdf-thumb:412"], blockedMs: 470 },
    ]);
    expect(summary.count).toBe(3);
    expect(summary.maxMs).toBe(480);
    expect(summary.slow).toBe(1);
    expect(summary.worst[0]?.blame).toEqual(["pdf-thumb:412"]);
    expect(summary.meanMs).toBeCloseTo(164, 0);
  });

  it("is empty rather than NaN with nothing recorded", () => {
    const summary = summariseInputDelay([]);
    expect(summary).toMatchObject({ count: 0, meanMs: 0, p95Ms: 0, maxMs: 0, slow: 0 });
    expect(summary.worst).toEqual([]);
  });

  it("blames at the browser's own long-task threshold", () => {
    expect(INPUT_DELAY_BLAME_MS).toBe(50);
  });
});
