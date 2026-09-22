import { describe, it, expect, beforeAll } from "vitest";
import { applyInkOp, type ScenePoint } from "./rasterInk";

beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() {
      const t: Record<string, unknown> = { createLinearGradient: () => ({ addColorStop: () => {} }) };
      return new Proxy(t, {
        get(o, p: string) { return p in o ? o[p] : () => {}; },
        set(o, p: string, v) { o[p] = v; return true; },
      });
    }
  };
});

/** What the destination context is actually asked to do. */
function destCalls(points: ScenePoint[]) {
  const calls: string[] = [];
  const ctx = new Proxy(
    { createLinearGradient: () => ({ addColorStop: () => {} }) } as Record<string, unknown>,
    { get(o, p: string) { return p in o ? o[p] : (...a: unknown[]) => calls.push(`${p}(${a.length})`); },
      set(o, p: string, v) { o[p] = v; return true; } },
  );
  const op = { kind: "draw" as const, color: "#c41e3a", baseWidth: 10, maxFullness: 1,
    pressureClip: 1, pressureSensitive: false, speedInk: 0.6, speedBlotBlend: 0.9,
    blotTipGrow: 0.9, points };
  applyInkOp(ctx as unknown as CanvasRenderingContext2D, op, 1);
  return calls;
}

describe("default pen replays taps and strokes through the same ribbon", () => {
  /*
   * Dwell clusters used to stamp a textured disc. The default pen now uses
   * the same ribbon replay as a long stroke, without a separate disc/blit.
   */
  it("paints a dwell cluster through the ribbon with round caps", () => {
    const dwell: ScenePoint[] = [];
    for (let i = 0; i < 30; i++)
      dwell.push({ x: Math.sin(i) * 0.08, y: Math.cos(i) * 0.08, pressure: 0.6, slowness: 1.9 });
    const calls = destCalls(dwell);
    expect(calls.filter((c) => c.startsWith("fill(")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith("drawImage("))).toBe(false);
    expect(calls.some((c) => c.startsWith("arc("))).toBe(true);
  });

  it("does the same for a stroke long enough to be a ribbon", () => {
    const pts: ScenePoint[] = [];
    for (let i = 0; i < 60; i++) pts.push({ x: i * 3, y: i * 0.4, pressure: 0.6, slowness: 1.9 });
    const calls = destCalls(pts);
    expect(calls.filter((c) => c.startsWith("fill(")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("drawImage")).length).toBe(0);
  });
});
