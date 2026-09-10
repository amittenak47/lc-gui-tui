import { describe, expect, it } from "vitest";

import { expandInkTurns, type ScenePoint } from "../rasterInk";
import { SIMPLIFY_STORAGE_FRACTION, simplifyInkPoints, smoothInkPoints } from "../inkSmoothing";
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
  it("does not revisit source geometry or restyle the frozen prefix", () => {
    let prefixReads = 0;
    const spine = Array.from({ length: 500 }, (_, i) => ({
      get x() { if (i < 50) prefixReads++; return i * 3; },
      y: Math.sin(i / 12) * 15,
      r: 4 + (i % 7) / 10,
      rgb: [40, 50, 60] as [number, number, number],
    }));
    const raw: ScenePoint[] = [];
    const first = reshapeLiveSpine(spine, 0.6, null, raw);
    expect(first.from).toBeGreaterThan(0);
    prefixReads = 0;
    spine.push({ x: 1500, y: 0, r: 4, rgb: [60, 70, 80] });
    const next = reshapeLiveSpine(spine, 0.6, first.cache, raw);
    expect(prefixReads).toBe(0);
    expect(next.points[0]).toBe(first.points[0]);
    expect(next.points.at(-1)!.x).toBe(1500);
  });
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

  it("live reshape at lift keeps at least as many points as a storage bake", () => {
    const spine: { x: number; y: number; r: number; p: number }[] = [];
    for (let i = 0; i < 80; i++) {
      spine.push({
        x: i * 4,
        y: Math.sin(i / 3) * 14 + (i % 5) * 0.4,
        r: 6,
        p: 0.5,
      });
    }
    const rawScene: ScenePoint[] = [];
    let cache = null as ReturnType<typeof reshapeLiveSpine>["cache"];
    let live = reshapeLiveSpine(spine, 0.35, cache, rawScene);
    for (let n = 12; n <= spine.length; n += 8) {
      live = reshapeLiveSpine(spine.slice(0, n), 0.35, cache, rawScene);
      cache = live.cache;
    }
    const baked = bakeSpine(spine, { smoothing: 0.35 });
    const scenes = spine.map((p) => ({ x: p.x, y: p.y, pressure: p.p }));
    const stored = simplifyInkPoints(scenes, 12 * SIMPLIFY_STORAGE_FRACTION);
    expect(live.points.length).toBeGreaterThanOrEqual(stored.length);
    expect(live.points.length).not.toBe(baked.points.length);
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
