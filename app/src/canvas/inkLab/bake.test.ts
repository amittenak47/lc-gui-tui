import { describe, expect, it } from "vitest";

import { expandInkTurns, type ScenePoint } from "../rasterInk";
import { smoothInkPoints } from "../inkSmoothing";
import { bakeCatmull, bakeSpine } from "./bake";

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
});
