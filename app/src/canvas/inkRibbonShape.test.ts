import { describe, it, expect } from "vitest";
import { coalesceRibbonPoints, inkStrokePointStyles, blotGrowTFromTicks,
  blotTicksToFull, type ScenePoint } from "./rasterInk";

const SCALE = 1;
const mkOp = (points: ScenePoint[], width: number) => ({
  kind: "draw" as const, color: "#2244aa", baseWidth: width, maxFullness: 1,
  pressureClip: 1, pressureSensitive: false, speedInk: 0.6, speedBlotBlend: 0, points,
});

/** Greatest distance from an original sample to the coalesced spine. */
function maxSag(orig: readonly ScenePoint[], kept: readonly ScenePoint[]) {
  let worst = 0;
  for (const p of orig) {
    let best = Infinity;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i - 1], b = kept[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

function quarterTurn() {
  const pts: ScenePoint[] = [];
  for (let i = 0; i <= 300; i++) {
    const a = (i / 300) * (Math.PI / 2);
    pts.push({ x: Math.cos(a) * 60, y: Math.sin(a) * 60, pressure: 0.6, slowness: 1.2 });
  }
  return pts;
}

describe("coalescing keeps corners", () => {
  /*
   * The merge threshold scales with the stroke's half-width, so without a
   * curvature term the flattening got worse exactly where strokes are widest
   * and their corners most visible -- a quarter turn at w=48 came out as eight
   * vertices. Densifying afterwards cannot repair it: it interpolates along
   * the chord, so every vertex it adds is collinear.
   */
  it("holds the spine sub-pixel however wide the stroke", () => {
    for (const width of [6, 14, 28, 48]) {
      const pts = quarterTurn();
      const kept = coalesceRibbonPoints(pts, inkStrokePointStyles(mkOp(pts, width), 0), SCALE);
      expect(maxSag(pts, kept.points)).toBeLessThanOrEqual(0.36);
      // A quarter turn needs real vertices at every width, not a few plates.
      expect(kept.points.length).toBeGreaterThan(20);
    }
  });

  it("still thins a straight run, which is what coalescing is for", () => {
    const pts: ScenePoint[] = [];
    for (let i = 0; i <= 200; i++) pts.push({ x: i * 0.9, y: 0, pressure: 0.6, slowness: 1.2 });
    const kept = coalesceRibbonPoints(pts, inkStrokePointStyles(mkOp(pts, 28), 0), SCALE);
    expect(kept.points.length).toBeLessThan(pts.length / 3);
  });
});

describe("hold growth curve", () => {
  it("settles instead of lunging, over the same budget", () => {
    const blend = 0.9, full = blotTicksToFull(blend);
    // Ease-out put 43% of the pool in the first quarter of the hold.
    expect(blotGrowTFromTicks(Math.round(full * 0.25), blend)).toBeLessThan(0.25);
    expect(blotGrowTFromTicks(Math.round(full * 0.5), blend)).toBeCloseTo(0.5, 1);
    expect(blotGrowTFromTicks(0, blend)).toBe(0);
    expect(blotGrowTFromTicks(full, blend)).toBeCloseTo(1, 9);
    let prev = -1;
    for (let t = 0; t <= full; t++) {
      const v = blotGrowTFromTicks(t, blend);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
