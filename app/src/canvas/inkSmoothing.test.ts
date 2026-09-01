import { describe, expect, it } from "vitest";

import {
  simplifyModulatedInkPoints,
  clampLiveLag,
  roundInkCorners,
  simplifyInkPoints,
  smoothInkPoints,
  smoothLiveInkWindow,
  liveSmoothingTau,
  liveSmoothingWeight,
  INK_SMOOTHING_DEFAULT,
  LIVE_MAX_LAG_NIBS,
  LIVE_SMOOTHING_MAX_TAU_MS,
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

  it("carries slowness onto the points it cuts in", () => {
    const out = roundInkCorners([
      { x: 0, y: 0, pressure: NO_PRESSURE, slowness: 0.2 },
      { x: 10, y: 0, pressure: NO_PRESSURE, slowness: 0.8 },
      { x: 20, y: 0, pressure: NO_PRESSURE, slowness: 0.8 },
    ]);
    // Every point keeps a pace: without one, speed ink reads the neutral
    // fallback and the whole stroke flattens to an even width on the lift.
    for (const point of out) {
      expect(point.slowness).toBeGreaterThan(0);
    }
    expect(out[0].slowness).toBe(0.2);
    expect(out[out.length - 1].slowness).toBe(0.8);
  });

  it("leaves a stroke written without speed ink unpaced", () => {
    for (const point of roundInkCorners(path([0, 0], [10, 0], [10, 10]))) {
      expect(point.slowness).toBeUndefined();
    }
  });
});

describe("smoothInkPoints", () => {
  it("leaves the stamps untouched at zero strength", () => {
    const points = jitteryLine();
    expect(smoothInkPoints(points, 0, 3)).toEqual([...points]);
  });

  it("does not thin a stamp chain at zero strength", () => {
    const stamps = Array.from({ length: 200 }, (_, i) => ({
      x: i * 0.3,
      y: 0,
      pressure: NO_PRESSURE,
    }));
    expect(smoothInkPoints(stamps, 0, 3)).toEqual(stamps);
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

  /*
   * The dial has to move *everywhere*, not just twice.
   *
   * Rounding used to be bought in whole passes through `ceil`, so the slider's
   * output was an integer 0–3: measured across its travel it changed at 55%
   * and at 90% and nowhere else, and below 24% the simplifier was still pinned
   * at its storage floor. A writer turning it from 10% to 50% was changing a
   * number that fed into nothing, which is why the range could not be felt.
   *
   * These two tests are the guard on that. They do not care how smoothing is
   * implemented — only that every part of the dial buys something.
   */
  it("moves at every step of its travel, not at two thresholds", () => {
    const points = jitteryLine();
    const steps = 12;
    const lengths = Array.from({ length: steps + 1 }, (_, i) =>
      pathLength(smoothInkPoints(points, i / steps, 3)),
    );
    for (let i = 1; i < lengths.length; i++) {
      // Strictly shorter than the notch below it: no dead zones, no plateaus.
      expect(lengths[i]).toBeLessThan(lengths[i - 1]);
    }
  });

  it("has a bottom quarter that does something", () => {
    const points = jitteryLine();
    const off = pathLength(smoothInkPoints(points, 0, 3));
    const nudged = pathLength(smoothInkPoints(points, 0.1, 3));
    const quarter = pathLength(smoothInkPoints(points, 0.25, 3));
    expect(nudged).toBeLessThan(off);
    expect(quarter).toBeLessThan(nudged);
  });

  it("does not pay for the continuity in points", () => {
    // The fractional pass must not be a fourth pass in disguise — a stroke at
    // full smoothing carries no more points than three passes ever produced.
    const points = jitteryLine();
    const full = smoothInkPoints(points, 1, 3);
    const justUnder = smoothInkPoints(points, 0.99, 3);
    expect(justUnder.length).toBeLessThanOrEqual(full.length);
    expect(full.length).toBeLessThan(points.length * 8);
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

describe("live smoothing", () => {
  it("curves only a bounded recent window and keeps the pointer tip exact", () => {
    const raw = Array.from({ length: 200 }, (_, index) => ({
      x: index,
      y: index % 2 === 0 ? 0 : 2,
      pressure: 0.2 + index / 1000,
      slowness: 0.3 + index / 2000,
    }));
    const preview = smoothLiveInkWindow(raw, 1, 2);
    expect(preview.fromIndex).toBeGreaterThan(100);
    expect(preview.points).toHaveLength(raw.length - preview.fromIndex);
    expect(preview.points.at(-1)).toEqual(raw.at(-1));
    expect(preview.points[5]!.pressure).toBe(raw[preview.fromIndex + 5]!.pressure);
    expect(preview.points[5]!.slowness).toBe(raw[preview.fromIndex + 5]!.slowness);
    expect(preview.points[5]!.y).not.toBe(raw[preview.fromIndex + 5]!.y);
  });

  it("does not move the join into the immutable prefix", () => {
    const raw = path([0, 0], [1, 2], [2, 0], [3, 2], [4, 0], [5, 2]);
    const preview = smoothLiveInkWindow(raw, 1, 1, 2);
    expect(preview.points[0]).toEqual(raw[preview.fromIndex]);
  });

  it("goes straight to the pen when the dial is off", () => {
    expect(liveSmoothingTau(0)).toBe(0);
    expect(liveSmoothingWeight(8, liveSmoothingTau(0))).toBe(1);
  });

  it("pulls harder the longer it has been since the last sample", () => {
    const tau = liveSmoothingTau(1);
    expect(liveSmoothingWeight(4, tau)).toBeLessThan(liveSmoothingWeight(16, tau));
    // Always some progress toward the pen, and never past it.
    for (const dt of [0, 1, 4, 16, 100]) {
      const w = liveSmoothingWeight(dt, tau);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it("lags the same in milliseconds whatever the pen's report rate", () => {
    const tau = liveSmoothingTau(0.6);
    // Chase a pen sitting 100 units away for 32ms, once at 60Hz and once at
    // 240Hz. A per-sample weight would filter the fast pen four times harder;
    // a time constant lands them in the same place.
    const chase = (dt: number, steps: number) => {
      let nib = 0;
      for (let i = 0; i < steps; i++) {
        nib += (100 - nib) * liveSmoothingWeight(dt, tau);
      }
      return nib;
    };
    expect(chase(16, 2)).toBeCloseTo(chase(4, 8), 5);
  });

  it("caps lag in nib widths so tight loops survive at full strength", () => {
    expect(LIVE_SMOOTHING_MAX_TAU_MS).toBe(55);
    expect(liveSmoothingTau(1)).toBe(LIVE_SMOOTHING_MAX_TAU_MS);
    expect(liveSmoothingTau(0)).toBe(0);
    expect(liveSmoothingTau(0.5)).toBeGreaterThan(14);

    const nibWidth = 3;
    const maxLag = nibWidth * LIVE_MAX_LAG_NIBS;
    const cx = 100;
    const cy = 100;
    const r = 50;
    const lagNibs = 5;

    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const penX = cx + r * Math.cos(angle);
      const penY = cy + r * Math.sin(angle);
      const nibX = cx + r * Math.cos(angle - lagNibs * nibWidth / r);
      const nibY = cy + r * Math.sin(angle - lagNibs * nibWidth / r);
      const clamped = clampLiveLag(nibX, nibY, penX, penY, maxLag);
      const dist = Math.hypot(clamped.x - penX, clamped.y - penY);
      expect(dist).toBeLessThanOrEqual(maxLag + 1e-9);
    }
  });

  it("no-ops clampLiveLag when the nib is already inside the budget", () => {
    const penX = 10;
    const penY = 20;
    const nibX = 12;
    const nibY = 21;
    const clamped = clampLiveLag(nibX, nibY, penX, penY, 5);
    expect(clamped.x).toBe(nibX);
    expect(clamped.y).toBe(nibY);
  });

  it("keeps circle radius above 0.75r when chasing with lag clamping", () => {
    const nibWidth = 3;
    const maxLag = nibWidth * LIVE_MAX_LAG_NIBS;
    const cx = 200;
    const cy = 200;
    const r = 40;
    const tau = liveSmoothingTau(1);
    let nibX = cx + r;
    let nibY = cy;
    const dt = 16;

    for (let step = 0; step < 200; step++) {
      const angle = (step / 200) * Math.PI * 2;
      const penX = cx + r * Math.cos(angle);
      const penY = cy + r * Math.sin(angle);
      const w = liveSmoothingWeight(dt, tau);
      nibX += (penX - nibX) * w;
      nibY += (penY - nibY) * w;
      const clamped = clampLiveLag(nibX, nibY, penX, penY, maxLag);
      nibX = clamped.x;
      nibY = clamped.y;
      const distFromCenter = Math.hypot(nibX - cx, nibY - cy);
      expect(distFromCenter).toBeGreaterThan(0.75 * r);
    }
  });

  it("treats a stale or nonsense gap as a catch-up, not a stall", () => {
    const tau = liveSmoothingTau(1);
    // Coalesced samples can share a clock tick; the nib must still move.
    expect(liveSmoothingWeight(0, tau)).toBeGreaterThan(0);
    // Gaps past LIVE_SMOOTHING_MAX_DT_MS clamp — same pull as a long frame.
    const catchUp = liveSmoothingWeight(500, tau);
    expect(catchUp).toBe(liveSmoothingWeight(32, tau));
    expect(catchUp).toBeGreaterThan(liveSmoothingWeight(4, tau));
    expect(liveSmoothingWeight(Number.NaN, tau)).toBe(catchUp);
    // clampLiveLag pulls the nib back when it trails too far.
    const pulled = clampLiveLag(100, 100, 0, 0, 10);
    expect(Math.hypot(pulled.x, pulled.y)).toBeCloseTo(10);
  });
});

describe("simplifyModulatedInkPoints", () => {
  /** A pen dragged in a straight line at a perfectly steady pressure. */
  function steadyLine(count: number, pressure = 0.6): ScenePoint[] {
    return Array.from({ length: count }, (_, i) => ({
      x: i * 1.1,
      y: 0,
      pressure,
      slowness: 0.5,
    }));
  }

  it("collapses a line drawn at a steady pressure", () => {
    // Nothing here is expressible: same direction, same alpha, same width.
    expect(simplifyModulatedInkPoints(steadyLine(50), 0.05)).toHaveLength(2);
  });

  it("collapses an evenly rising pressure ramp, because the renderer rebuilds it", () => {
    // Worth being explicit about, because it looks like data loss and is not:
    // `stampAlongSegment` interpolates pressure and slowness linearly between
    // stored points. A ramp that is already linear is therefore reproduced
    // exactly from its two ends — every point in between is the renderer's own
    // arithmetic, written down.
    const ramp = steadyLine(50).map((point, i) => ({ ...point, pressure: i / 49 }));
    expect(simplifyModulatedInkPoints(ramp, 0.05)).toHaveLength(2);
  });

  it("keeps the swell of a stroke whose pressure does not rise evenly", () => {
    // The real case: pressed hardest in the middle. Two points would redraw
    // this as a flat ramp from light to light, losing the swell entirely.
    const swell = steadyLine(50).map((point, i) => ({
      ...point,
      pressure: Math.sin((i / 49) * Math.PI),
    }));
    const out = simplifyModulatedInkPoints(swell, 0.05);
    // A handful of points, not two and not fifty: a sine is what piecewise
    // linear interpolation is worst at, and eight segments hold it to inside
    // the alpha quantum.
    expect(out.length).toBeGreaterThan(5);
    expect(out.length).toBeLessThan(20);
    // The peak survives — it is the one sample the stroke is about.
    const peak = Math.max(...out.map((p) => p.pressure));
    expect(peak).toBeGreaterThan(0.98);
  });

  it("keeps a corner", () => {
    const corner: ScenePoint[] = [
      ...steadyLine(10),
      ...Array.from({ length: 10 }, (_, i) => ({
        x: 9.9,
        y: (i + 1) * 1.1,
        pressure: 0.6,
        slowness: 0.5,
      })),
    ];
    const out = simplifyModulatedInkPoints(corner, 0.05);
    expect(out.some((p) => Math.abs(p.x - 9.9) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(true);
  });

  it("keeps a point whose slowness moves even when pressure does not", () => {
    // Slowness drives width, so this is a stroke that gets fatter without
    // getting darker — invisible to a pressure-only test.
    const points = steadyLine(30).map((point, i) => ({
      ...point,
      slowness: i < 15 ? 0.1 : 0.9,
    }));
    expect(simplifyModulatedInkPoints(points, 0.05).length).toBeGreaterThan(2);
  });

  it("never moves the endpoints", () => {
    const points = steadyLine(40);
    const out = simplifyModulatedInkPoints(points, 0.05);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[39]);
  });

  it("keeps the original sample objects, so pressure is never interpolated", () => {
    const points = steadyLine(40);
    for (const point of simplifyModulatedInkPoints(points, 0.05)) {
      expect(points).toContain(point);
    }
  });

  it("does not collapse across the NO_PRESSURE sentinel", () => {
    // -1 is "mouse or touch", not "pressed very lightly". Interpolating between
    // it and a real reading would invent a pressure nobody applied.
    const points: ScenePoint[] = [
      { x: 0, y: 0, pressure: NO_PRESSURE },
      { x: 1, y: 0, pressure: 0.5 },
      { x: 2, y: 0, pressure: NO_PRESSURE },
    ];
    expect(simplifyModulatedInkPoints(points, 0.05)).toHaveLength(3);
  });

  it("does not collapse across an absent slowness", () => {
    // Absent means "speed ink was off" and reads as neutral; mixing it with a
    // real reading is not something to average.
    const points: ScenePoint[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 1, y: 0, pressure: 0.5, slowness: 0.5 },
      { x: 2, y: 0, pressure: 0.5 },
    ];
    expect(simplifyModulatedInkPoints(points, 0.05)).toHaveLength(3);
  });

  it("leaves a stroke of two points alone", () => {
    const points = steadyLine(2);
    expect(simplifyModulatedInkPoints(points, 0.05)).toEqual(points);
  });

  it("does nothing at a tolerance of zero", () => {
    const points = steadyLine(20);
    expect(simplifyModulatedInkPoints(points, 0)).toHaveLength(20);
  });
});

/**
 * The dial used to be `dial * 0.4`: the whole useful range sat in the bottom of
 * the travel, and 100% never reached the last rounding pass. With speed ink on
 * — where the width swing is loud — the top half did nothing you could see.
 */
describe("smoothing dial range", () => {
  function zigzag(count: number): ScenePoint[] {
    return Array.from({ length: count }, (_, i) => ({
      x: i * 4,
      y: i % 2 === 0 ? 0 : 3,
      pressure: NO_PRESSURE,
    }));
  }

  function wobble(points: readonly ScenePoint[]): number {
    let total = 0;
    for (let i = 1; i < points.length - 1; i += 1) {
      const dx1 = points[i].x - points[i - 1].x;
      const dy1 = points[i].y - points[i - 1].y;
      const dx2 = points[i + 1].x - points[i].x;
      const dy2 = points[i + 1].y - points[i].y;
      total += Math.abs(Math.atan2(dy2, dx2) - Math.atan2(dy1, dx1));
    }
    return total;
  }

  it("keeps rounding harder all the way to the top of the dial", () => {
    const raw = zigzag(40);
    const half = wobble(smoothInkPoints(raw, 0.5, 3));
    const full = wobble(smoothInkPoints(raw, 1, 3));
    // The complaint was that these two looked the same.
    expect(full).toBeLessThan(half);
  });

  it("barely moves the settings writers already have", () => {
    const raw = zigzag(40);
    // A quarter turn used to be 0.1; the curve puts it within a hair of that,
    // so nobody's pen changes character because the ceiling went up.
    const quarter = smoothInkPoints(raw, 0.25, 3);
    expect(quarter.length).toBeGreaterThan(raw.length * 0.3);
  });

  it("still leaves a stroke alone at zero", () => {
    const raw = zigzag(12);
    expect(smoothInkPoints(raw, 0, 3)).toEqual([...raw]);
  });
});
