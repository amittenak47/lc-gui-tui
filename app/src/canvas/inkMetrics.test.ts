import { afterEach, describe, expect, it, vi } from "vitest";

import type { inkMetrics as InkMetrics } from "./inkMetrics";

/**
 * `enabled` is read once at import, and the counters are module state, so every
 * case gets its own module instance with a clock it controls.
 *
 * The clock starts at {@link DOWN} rather than zero: `end` uses a zero start
 * time as its "no stroke is open" sentinel, and a real `performance.now()` is
 * never 0 by the time a pen touches the glass.
 */
const DOWN = 1000;
let clock = DOWN;
let frameCallback: ((time: number) => void) | null = null;

async function loadMetrics(enabled = true): Promise<typeof InkMetrics> {
  vi.resetModules();
  clock = DOWN;
  frameCallback = null;
  vi.stubGlobal("window", {} as unknown as Window);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (enabled && key === "lc.ink.metrics" ? "1" : null),
  });
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

  it("stays inert when the flag is off", async () => {
    const metrics = await loadMetrics(false);
    metrics.begin();
    clock = DOWN + 500;
    metrics.move(4, DOWN);
    metrics.painted(DOWN);
    expect(metrics.enabled).toBe(false);
    expect(metrics.end()).toBeNull();
    expect(frameCallback).toBeNull();
    expect(metrics.summary().strokes).toBe(0);
  });
});
