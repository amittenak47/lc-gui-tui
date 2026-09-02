import { describe, it, expect } from "vitest";
import { buildPointGrid, nearestOnGrid } from "./rasterInk";

let seed = 77; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
type P = { x: number; y: number };

/** The contract: lowest index attaining the minimum distance. */
function linear(points: readonly P[], at: P): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - at.x, points[i].y - at.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

describe("point grid nearest", () => {
  it("returns exactly what the linear scan returns, ties included", () => {
    let queries = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 96 + Math.floor(rnd() * 3000);
      const pts: P[] = []; let x = 0, y = 0;
      const stretch = rnd() < 0.3 ? 40 : 1;   // some very elongated strokes
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.15 && pts.length) { pts.push({ ...pts[pts.length - 1] }); continue; }   // exact duplicates
        if (r < 0.45) { x += (rnd() - 0.5) * 0.1; y += (rnd() - 0.5) * 0.1; }
        else { x += (rnd() - 0.5) * 12 * stretch; y += (rnd() - 0.5) * 12; }
        pts.push({ x, y });
      }
      const grid = buildPointGrid(pts);
      expect(grid).not.toBeNull();
      for (let q = 0; q < 30; q++) {
        // On a sample, near a sample, and well outside the stroke.
        const s = pts[Math.floor(rnd() * n)];
        const kind = rnd();
        const at = kind < 0.4 ? { x: s.x, y: s.y }
          : kind < 0.8 ? { x: s.x + (rnd() - 0.5) * 3, y: s.y + (rnd() - 0.5) * 3 }
          : { x: s.x + (rnd() - 0.5) * 4000, y: s.y + (rnd() - 0.5) * 4000 };
        expect(nearestOnGrid(pts, grid!, at)).toBe(linear(pts, at));
        queries++;
      }
    }
    expect(queries).toBe(9000);
  });

  it("handles every sample on one spot and a straight line", () => {
    const same: P[] = []; for (let i = 0; i < 300; i++) same.push({ x: 5, y: 5 });
    const line: P[] = []; for (let i = 0; i < 300; i++) line.push({ x: i * 0.7, y: 0 });
    for (const pts of [same, line]) {
      const grid = buildPointGrid(pts)!;
      for (const at of [{ x: 5, y: 5 }, { x: 100, y: 0 }, { x: -50, y: 30 }, { x: 5.0001, y: 4.9999 }]) {
        expect(nearestOnGrid(pts, grid, at)).toBe(linear(pts, at));
      }
    }
  });

  it("declines to build for short strokes", () => {
    const pts: P[] = []; for (let i = 0; i < 50; i++) pts.push({ x: i, y: 0 });
    expect(buildPointGrid(pts)).toBeNull();
  });
});
