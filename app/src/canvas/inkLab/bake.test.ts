import { describe, expect, it } from "vitest";

import { expandInkTurns, type ScenePoint } from "../rasterInk";
import { smoothInkPoints } from "../inkSmoothing";
import { bakeCatmull, bakeSpine, reshapeLiveSpine, reshapeSpine } from "./bake";
import { emptyAabb, expandAabb } from "./instance";

function line(): ScenePoint[] {
  return [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 10, y: 0, pressure: 0.5 },
    { x: 20, y: 8, pressure: 0.5 },
    { x: 30, y: 8, pressure: 0.5 },
    { x: 40, y: 0, pressure: 0.5 },
  ];
}

describe("lift bake", () => {
  it("Catmull path matches expandInkTurns on a fixture", () => {
    const pts = line();
    const expected = expandInkTurns(smoothInkPoints(pts, 0.35, 8));
    expect(bakeCatmull(pts, 8)).toEqual(expected);
  });

  it("clothoid is off by default", () => {
    const spine = line().map((p) => ({ x: p.x, y: p.y, r: 6 }));
    const out = bakeSpine(spine);
    expect(out.bake).toBe("catmull");
    expect(out.points.length).toBeGreaterThan(1);
    expect(Number.isFinite(out.bakeMs)).toBe(true);
  });

  it("clothoid remeshes even when Chaikin is off", () => {
    const spine = line().map((p) => ({ x: p.x, y: p.y, r: 6 }));
    const out = bakeSpine(spine, { clothoid: true, smoothing: 0 });
    expect(out.bake).toBe("clothoid");
    expect(out.points.length).toBeGreaterThan(spine.length);
    expect(out.points[0]!.x).toBeCloseTo(0);
    expect(out.points[out.points.length - 1]!.x).toBeCloseTo(40);
  });

  it("smoothing 0 keeps the raw spine", () => {
    const spine = line().map((p) => ({ x: p.x, y: p.y, r: 6 }));
    const out = bakeSpine(spine, { smoothing: 0 });
    expect(out.points).toHaveLength(spine.length);
    expect(out.points[2]!.x).toBeCloseTo(20);
    expect(out.points[2]!.y).toBeCloseTo(8);
  });

  it("live reshape keeps the endpoints", () => {
    const spine = line().map((p) => ({ x: p.x, y: p.y, r: 6 }));
    const out = reshapeSpine(spine, 0.35);
    expect(out[0]!.x).toBeCloseTo(0);
    expect(out[0]!.y).toBeCloseTo(0);
    expect(out[out.length - 1]!.x).toBeCloseTo(40);
    expect(out[out.length - 1]!.y).toBeCloseTo(0);
    expect(Math.abs(out[2]!.y)).toBeLessThan(8);
  });

  it("live-smooth tail keeps endpoints and freezes the prefix", () => {
    const rawScene: ScenePoint[] = [];
    const spine = [];
    for (let i = 0; i < 400; i++) {
      spine.push({
        x: i * 3,
        y: Math.sin(i / 18) * 8,
        r: 6,
        slow: 0.5,
      });
    }
    let cache = null as ReturnType<typeof reshapeLiveSpine>["cache"];
    let prev: { x: number; y: number }[] | null = null;
    let frozen = 0;
    let drift = 0;
    for (let n = 20; n <= spine.length; n += 10) {
      const slice = spine.slice(0, n);
      const r = reshapeLiveSpine(slice, 0.6, cache, rawScene);
      cache = r.cache;
      if (prev && frozen > 0) {
        for (let i = 0; i < frozen && i < r.points.length && i < prev.length; i++) {
          drift = Math.max(
            drift,
            Math.hypot(r.points[i]!.x - prev[i]!.x, r.points[i]!.y - prev[i]!.y),
          );
        }
      }
      prev = r.points.map((p) => ({ x: p.x, y: p.y }));
      frozen = cache ? cache.prefix.length : 0;
    }
    expect(frozen).toBeGreaterThan(0);
    expect(drift).toBe(0);
    const last = reshapeLiveSpine(spine, 0.6, cache, rawScene);
    expect(last.from).toBeGreaterThan(0);
    expect(last.points[0]!.x).toBeCloseTo(0);
    expect(last.points[last.points.length - 1]!.x).toBeCloseTo(spine[spine.length - 1]!.x);
    expect(last.points[0]!.slow).toBeCloseTo(0.5);
    const tail = emptyAabb();
    const full = emptyAabb();
    for (const p of last.points) expandAabb(full, p);
    for (let i = last.from; i < last.points.length; i++) expandAabb(tail, last.points[i]!);
    const tailArea = (tail.maxX - tail.minX) * (tail.maxY - tail.minY);
    const fullArea = (full.maxX - full.minX) * (full.maxY - full.minY);
    expect(tailArea).toBeLessThan(fullArea * 0.5);
  });
});
