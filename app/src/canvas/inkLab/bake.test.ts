import { describe, expect, it } from "vitest";

import { expandInkTurns, type ScenePoint } from "../rasterInk";
import { smoothInkPoints } from "../inkSmoothing";
import { bakeCatmull, bakeSpine, reshapeSpine } from "./bake";

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
});
