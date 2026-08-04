import { describe, expect, it } from "vitest";

import {
  roundInkCorners,
  simplifyInkPoints,
  smoothInkPoints,
  INK_SMOOTHING_DEFAULT,
  SIMPLIFY_MAX_FRACTION,
} from "./inkSmoothing";
import { NO_PRESSURE, type ScenePoint } from "./rasterInk";

function path(...pairs: Array<[number, number]>): ScenePoint[] {
  return pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE }));
}

/**
 * Path length, as a stand-in for how wobbly a polyline reads: a shaky hand
 * covers more ground than a steady one between the same two points.
 */
function pathLength(points: readonly ScenePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Total change of direction. Corner cutting spreads it; it does not remove it. */
function totalTurn(points: readonly ScenePoint[]): number {
  let turn = 0;
  for (let i = 2; i < points.length; i++) {
    const ax = points[i - 1].x - points[i - 2].x;
    const ay = points[i - 1].y - points[i - 2].y;
    const bx = points[i].x - points[i - 1].x;
    const by = points[i].y - points[i - 1].y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    turn += Math.abs(Math.atan2(cross, dot));
  }
  return turn;
}

function jitteryLine(count = 120): ScenePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: i * 2,
    y: (i % 2 === 0 ? 0.4 : -0.4) + Math.sin(i / 17) * 6,
    pressure: NO_PRESSURE,
  }));
}

describe("simplifyInkPoints", () => {
  it("drops points that sit on the line between their neighbours", () => {
    const out = simplifyInkPoints(path([0, 0], [5, 0], [10, 0], [15, 0]), 0.5);
    expect(out).toEqual(path([0, 0], [15, 0]));
  });

  it("keeps a corner the tolerance cannot swallow", () => {
    const out = simplifyInkPoints(path([0, 0], [10, 0], [10, 10]), 0.5);
    expect(out).toHaveLength(3);
  });

  it("never moves the ends", () => {
    const points = jitteryLine();
    const out = simplifyInkPoints(points, 2);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  });

  it("keeps the original samples, so pressure rides along", () => {
    const points: ScenePoint[] = [
      { x: 0, y: 0, pressure: 0.2 },
      { x: 5, y: 0.05, pressure: 0.5 },
      { x: 10, y: 0, pressure: 0.9 },
    ];
    const out = simplifyInkPoints(points, 1);
    for (const point of out) expect(points).toContain(point);
  });

  it("measures a doubled-back stroke against the line it doubled over", () => {
    // Out and straight back: the chord is zero-length at the ends, so a naive
    // perpendicular distance would keep everything or nothing.
    const out = simplifyInkPoints(path([0, 0], [10, 0], [20, 0], [10, 0], [0, 0]), 0.5);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.some((p) => p.x === 20)).toBe(true);
  });

  it("passes short strokes through untouched", () => {
    expect(simplifyInkPoints(path([1, 2], [3, 4]), 5)).toEqual(path([1, 2], [3, 4]));
  });

  it("does nothing at zero tolerance", () => {
    const points = jitteryLine(20);
    expect(simplifyInkPoints(points, 0)).toHaveLength(20);
  });
});

describe("roundInkCorners", () => {
  it("pins both ends and cuts the corners between", () => {
    const points = path([0, 0], [10, 0], [10, 10]);
    const out = roundInkCorners(points);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
    expect(out.some((p) => p.x === 10 && p.y === 0)).toBe(false);
  });

  it("takes the turn out of a right angle", () => {
    const sharp = totalTurn(path([0, 0], [10, 0], [10, 10]));
    const soft = totalTurn(roundInkCorners(path([0, 0], [10, 0], [10, 10])));
    // Same total change of direction, spread over more, gentler joints.
    expect(soft).toBeCloseTo(sharp, 5);
    expect(roundInkCorners(path([0, 0], [10, 0], [10, 10])).length).toBeGreaterThan(3);
  });

  it("never blends a real pressure with the mouse sentinel", () => {
    const out = roundInkCorners([
      { x: 0, y: 0, pressure: NO_PRESSURE },
      { x: 10, y: 0, pressure: 0.8 },
      { x: 20, y: 0, pressure: 0.8 },
    ]);
    for (const point of out) {
      expect(point.pressure === NO_PRESSURE || point.pressure >= 0).toBe(true);
    }
  });

  it("leaves a two-point stroke alone", () => {
    expect(roundInkCorners(path([0, 0], [5, 5]))).toEqual(path([0, 0], [5, 5]));
  });
});

describe("smoothInkPoints", () => {
  it("is a no-op at zero strength", () => {
    const points = jitteryLine();
    expect(smoothInkPoints(points, 0, 3)).toEqual(points);
  });

  it("takes the wobble out at the default strength", () => {
    const points = jitteryLine();
    const out = smoothInkPoints(points, INK_SMOOTHING_DEFAULT, 3);
    expect(pathLength(out)).toBeLessThan(pathLength(points));
    // The shape survives: it is still a stroke of roughly the same reach.
    expect(pathLength(out)).toBeGreaterThan(pathLength(points) * 0.7);
  });

  it("smooths harder as the dial goes up", () => {
    const points = jitteryLine();
    const raw = pathLength(points);
    const light = pathLength(smoothInkPoints(points, 0.2, 3));
    const heavy = pathLength(smoothInkPoints(points, 1, 3));
    expect(light).toBeLessThan(raw);
    expect(heavy).toBeLessThan(light);
  });

  it("stays inside the ink the raw stroke would have laid down", () => {
    const points = jitteryLine();
    const nib = 3;
    const out = smoothInkPoints(points, 1, nib);
    // Every smoothed point is within the simplifier's budget of the raw path.
    const budget = nib * SIMPLIFY_MAX_FRACTION + 1e-6;
    for (const point of out) {
      let best = Infinity;
      for (let i = 1; i < points.length; i++) {
        best = Math.min(best, distanceToSegment(point, points[i - 1], points[i]));
      }
      expect(best).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps both ends exactly", () => {
    const points = jitteryLine();
    const out = smoothInkPoints(points, 1, 3);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  });

  it("does not blow up the point count", () => {
    const points = jitteryLine(400);
    expect(smoothInkPoints(points, 1, 3).length).toBeLessThan(points.length);
  });

  it("leaves a stroke too short to have a shape alone", () => {
    expect(smoothInkPoints(path([0, 0], [1, 1]), 1, 3)).toEqual(path([0, 0], [1, 1]));
  });
});

function distanceToSegment(p: ScenePoint, a: ScenePoint, b: ScenePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
