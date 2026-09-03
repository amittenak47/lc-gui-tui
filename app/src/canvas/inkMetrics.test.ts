import { afterEach, describe, expect, it, vi } from "vitest";

import type { inkMetrics as InkMetrics } from "./inkMetrics";

/**
 * `enabled` is read once at import, and the counters are module state, so every
 * case gets its own module instance with a clock it controls. Enabled cases set
 * `globalThis.__LC_INK_DEBUG__` before import (Vitest only).
 *
 * The clock starts at {@link DOWN} rather than zero: `end` uses a zero start
 * time as its "no stroke is open" sentinel, and a real `performance.now()` is
 * never 0 by the time a pen touches the glass.
 */
const DOWN = 1000;
let clock = DOWN;
let frameCallback: ((time: number) => void) | null = null;
let longTaskCallback: ((list: { getEntries(): PerformanceEntryList }) => void) | null = null;

/** Feed the observer a long task, as `[start, duration]` relative to pointerdown. */
function longTask(start: number, duration: number): void {
  longTaskCallback?.({
    getEntries: () =>
      [{ startTime: DOWN + start, duration }] as unknown as PerformanceEntryList,
  });
}

async function loadMetrics(debugInk = true): Promise<typeof InkMetrics> {
  vi.resetModules();
  clock = DOWN;
  frameCallback = null;
  longTaskCallback = null;
  vi.stubGlobal("__LC_INK_DEBUG__", debugInk);
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(cb: (list: { getEntries(): PerformanceEntryList }) => void) {
        longTaskCallback = cb;
      }
      observe(): void {}
      takeRecords(): PerformanceEntryList {
        return [];
      }
      disconnect(): void {}
    },
  );
  vi.stubGlobal("window", {} as unknown as Window);
  vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
    frameCallback = cb;
    return 1;
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  return (await import("./inkMetrics")).inkMetrics;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inkMetrics", () => {
  it("catches a main-thread stall that the paint latency flatters away", async () => {
    const metrics = await loadMetrics();
    metrics.begin();

    clock = DOWN + 11;
    metrics.move(1, DOWN + 11);
    metrics.painted(DOWN + 11);

    // The thread is gone from 11ms to 400ms. The browser does not queue 389ms
    // of moves — it dispatches one, stamped with its newest sample, and hides
    // the rest in the coalesced batch. Latency therefore reads as a couple of
    // frames at most, which is exactly the trap these three numbers exist for.
    clock = DOWN + 400;
    metrics.move(39, DOWN + 20);
    metrics.painted(DOWN + 398);

    clock = DOWN + 420;
    const stroke = metrics.end();

    expect(stroke).not.toBeNull();
    expect(stroke?.maxLatencyMs).toBe(2);
    expect(stroke?.maxSampleAgeMs).toBe(380);
    expect(stroke?.maxGapMs).toBe(389);
  });

  it("measures the first gap from pointerdown, not from the first move", async () => {
    const metrics = await loadMetrics();
    metrics.begin();
    clock = DOWN + 120;
    metrics.move(1, DOWN + 119);
    clock = DOWN + 200;
    expect(metrics.end()?.maxGapMs).toBe(120);
  });

  it("times the draw to the start of the next animation frame", async () => {
    const metrics = await loadMetrics();
    metrics.begin();

    clock = DOWN + 10;
    metrics.move(1, DOWN + 10);
    metrics.painted(DOWN + 10);
    // A second paint lands before the frame runs; the probe already in flight
    // covers it, so the wait is measured from the first of the two.
    clock = DOWN + 14;
    metrics.painted(DOWN + 14);
    expect(frameCallback).not.toBeNull();
    frameCallback?.(DOWN + 48);

    clock = DOWN + 200;
    expect(metrics.end()?.maxFrameMs).toBe(38);
  });

  it("keeps the worst frame wait, not the last", async () => {
    const metrics = await loadMetrics();
    metrics.begin();

    clock = DOWN + 10;
    metrics.painted(DOWN + 10);
    frameCallback?.(DOWN + 60);
    clock = DOWN + 70;
    metrics.painted(DOWN + 70);
    frameCallback?.(DOWN + 81);

    clock = DOWN + 200;
    expect(metrics.end()?.maxFrameMs).toBe(50);
  });

  it("counts recovered samples as the batch surplus over moves", async () => {
    const metrics = await loadMetrics();
    metrics.begin();
    for (let i = 1; i <= 5; i += 1) {
      clock = DOWN + i * 11;
      metrics.move(3, clock - 2);
    }
    clock = DOWN + 200;
    const stroke = metrics.end();
    expect(stroke?.moves).toBe(5);
    expect(stroke?.samples).toBe(15);
    expect(stroke?.recovered).toBe(10);
  });

  it("charges the stroke only for the part of a long task that overlapped it", async () => {
    const metrics = await loadMetrics();
    metrics.begin();

    // Straddles pointerdown: 60ms task, but only its last 20ms cost this stroke.
    longTask(-40, 60);
    // Squarely inside.
    longTask(80, 70);
    // Starts before the lift and runs past it — 10ms of the 90 belongs here.
    longTask(190, 90);

    clock = DOWN + 200;
    const stroke = metrics.end();
    expect(stroke?.longTasks).toBe(3);
    expect(stroke?.blockedMs).toBe(100);
    expect(stroke?.maxLongTaskMs).toBe(90);
  });

  it("ignores long tasks that fell between strokes", async () => {
    const metrics = await loadMetrics();
    metrics.begin();
    clock = DOWN + 200;
    metrics.end();

    // Landed in the gap between one lift and the next touch.
    longTask(220, 60);
    clock = DOWN + 400;
    metrics.begin();
    clock = DOWN + 600;
    const stroke = metrics.end();
    expect(stroke?.longTasks).toBe(0);
    expect(stroke?.blockedMs).toBe(0);
  });

  it("stays inert when DEBUG_INK is off", async () => {
    const metrics = await loadMetrics(false);
    metrics.begin();
    clock = DOWN + 500;
    metrics.move(4, DOWN);
    metrics.painted(DOWN);
    metrics.addStage("tessPaint", 12);
    metrics.live({ ringSamples: 40, spineN: 40 });
    metrics.path("incremental");
    expect(metrics.enabled).toBe(false);
    expect(metrics.end()).toBeNull();
    expect(frameCallback).toBeNull();
    expect(metrics.summary().strokes).toBe(0);
  });

  it("records live pipeline fields only when enabled", async () => {
    const metrics = await loadMetrics();
    metrics.begin();
    metrics.live({ ringSamples: 80, spineN: 12, transientTip: true, dirtyFrom: 4, bakedVerts: 20 });
    metrics.addStage("tick", 0.4);
    metrics.addStage("tessPaint", 2.2);
    metrics.addStage("tessPaint", 1.1);
    metrics.scratch(120, 80, 512, 512);
    metrics.overlay(2160, 2520, 2);
    metrics.rafPeriod(11);
    metrics.path("incremental");
    clock = DOWN + 200;
    const stroke = metrics.end();
    expect(stroke?.ringSamples).toBe(80);
    expect(stroke?.spineN).toBe(12);
    expect(stroke?.transientTip).toBe(true);
    expect(stroke?.dirtyFrom).toBe(4);
    expect(stroke?.bakedVerts).toBe(20);
    expect(stroke?.stages.tick).toBe(0.4);
    expect(stroke?.stages.tessPaint).toBe(2.2);
    expect(stroke?.scratchSw).toBe(120);
    expect(stroke?.scratchBackingW).toBe(512);
    expect(stroke?.overlayW).toBe(2160);
    expect(stroke?.overlayH).toBe(2520);
    expect(stroke?.dpr).toBe(2);
    expect(stroke?.maxRafMs).toBe(11);
    expect(stroke?.path).toBe("incremental");
  });
});
