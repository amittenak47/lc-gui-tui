import { describe, expect, it } from "vitest";

import {
  createInkLoadMeter,
  formatInkLoadDebug,
  INK_LOAD_BUDGET_MS,
  INK_LOAD_LIFT,
  INK_LOAD_SLOW_RED,
  type InkLoadFrame,
} from "./inkLoadMeter";

function cheap(extra: Partial<InkLoadFrame> = {}): InkLoadFrame {
  return {
    frameMs: 4,
    rafMs: 16,
    spineN: 20,
    dirtyFrom: 18,
    suffixHit: true,
    queued: 1,
    ...extra,
  };
}

function slow(extra: Partial<InkLoadFrame> = {}): InkLoadFrame {
  return {
    frameMs: INK_LOAD_BUDGET_MS + 8,
    rafMs: 16,
    spineN: 80,
    dirtyFrom: 60,
    suffixHit: true,
    queued: 2,
    ...extra,
  };
}

describe("inkLoadMeter", () => {
  it("ignores frames before begin", () => {
    const meter = createInkLoadMeter();
    meter.frame(slow());
    expect(meter.peek().calls).toBe(0);
    expect(meter.peek().level).toBe(0);
  });

  it("keeps cheap live paints in the green", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < 40; i++) meter.frame(cheap({ spineN: 10 + i }));
    expect(meter.peek().slowCalls).toBe(0);
    expect(meter.peek().level).toBeLessThan(0.35);
    expect(meter.peek().lift).toBe(false);
  });

  it("counts each live paint and fills toward lift on overruns", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < INK_LOAD_SLOW_RED; i++) meter.frame(slow());
    const snap = meter.peek();
    expect(snap.calls).toBe(INK_LOAD_SLOW_RED);
    expect(snap.slowCalls).toBe(INK_LOAD_SLOW_RED);
    expect(snap.level).toBeGreaterThanOrEqual(INK_LOAD_LIFT);
    expect(snap.lift).toBe(true);
  });

  it("taxes a full remesh on a long spine even when the clock is quiet", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < 24; i++) {
      meter.frame(
        cheap({
          spineN: 80,
          dirtyFrom: 0,
          suffixHit: false,
        }),
      );
    }
    expect(meter.peek().level).toBeGreaterThan(0.5);
  });

  it("resets on the next pointer down", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < INK_LOAD_SLOW_RED; i++) meter.frame(slow());
    expect(meter.peek().lift).toBe(true);
    meter.end();
    const next = meter.begin();
    expect(next.calls).toBe(0);
    expect(next.level).toBe(0);
    expect(next.lift).toBe(false);
  });

  it("formats the live call counts for the overlay", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    meter.frame(slow({ queued: 11, spineN: 90, dirtyFrom: 40 }));
    const text = formatInkLoadDebug(meter.peek());
    expect(text).toContain("paints 1");
    expect(text).toContain("slow 1");
    expect(text).toContain("pts 90");
    expect(text).toContain("queue 11");
    expect(text).toContain("backend");
    expect(text).toContain("suffix hit");
  });

  it("does not tax an incremental long spine", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < 40; i++) {
      meter.frame(
        cheap({
          spineN: 80,
          dirtyFrom: 79,
          suffixHit: true,
          backend: "canvas2d",
        }),
      );
    }
    expect(meter.peek().slowCalls).toBe(0);
    expect(meter.peek().level).toBeLessThan(0.35);
    expect(meter.peek().lift).toBe(false);
  });

  it("does not tax a WebGL suffix miss the way stamp remesh did", () => {
    const meter = createInkLoadMeter();
    meter.begin();
    for (let i = 0; i < 40; i++) {
      meter.frame(
        cheap({
          spineN: 80,
          dirtyFrom: 0,
          suffixHit: false,
          backend: "webgl2",
        }),
      );
    }
    expect(meter.peek().slowCalls).toBe(0);
    expect(meter.peek().level).toBeLessThan(0.35);
    expect(meter.peek().lift).toBe(false);
  });
});
