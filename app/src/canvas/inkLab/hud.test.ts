import { describe, expect, it } from "vitest";

import {
  createInkLabHudStats,
  formatInkLabHud,
  INK_LAB_HUD_ZERO,
  INK_LAB_SPARK_N,
} from "./hud";

describe("Ink lab HUD", () => {
  it("prints the zero readout the overlay starts with", () => {
    const text = formatInkLabHud(INK_LAB_HUD_ZERO);
    expect(text).toContain("backend none");
    expect(text).toContain("paints 0");
    expect(text).toContain("hold no");
    expect(text).toContain("suffix hit");
    expect(text).toContain("bake 0.0ms catmull");
    expect(text).toContain("frame 0.0ms");
    expect(text).not.toContain("avg");
  });

  it("prints min max avg once a stroke has samples", () => {
    const stats = createInkLabHudStats();
    stats.sample(2, 16, 1.5, 0.08);
    stats.sample(10, 17, 8, 0.1);
    const text = formatInkLabHud({
      ...INK_LAB_HUD_ZERO,
      frameMs: 10,
      rafMs: 17,
      drawMs: 8,
      ekfMs: 0.1,
      ...stats.snapshot(),
    });
    expect(text).toContain("frame 10.0ms  2.0–10.0  avg 6.0");
    expect(text).toContain("raf 17.0ms  16.0–17.0");
    expect(text).toContain("draw 8.00ms  1.50–8.00");
  });

  it("skips a zero raf so the first paint does not pin min at 0", () => {
    const stats = createInkLabHudStats();
    stats.sample(3, 0, 2, 0.05);
    stats.sample(4, 16.7, 2.2, 0.06);
    const snap = stats.snapshot();
    expect(snap.rafRange?.min).toBeCloseTo(16.7);
    expect(snap.frameRange?.n).toBe(2);
  });

  it("caps the spark at a short window", () => {
    const stats = createInkLabHudStats();
    for (let i = 0; i < INK_LAB_SPARK_N + 8; i++) stats.sample(1, 16, 1, 0.05);
    expect(stats.snapshot().spark?.length).toBe(INK_LAB_SPARK_N);
  });
});
