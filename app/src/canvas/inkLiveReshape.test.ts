import { describe, it, expect } from "vitest";
import { smoothInkPoints, smoothLiveInkPoints, type LiveSmoothCache } from "./inkSmoothing";
import { inkLineWidth, type ScenePoint } from "./rasterInk";

const nib = inkLineWidth(10, 0, false);
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** Sharpest direction change along the polyline, in degrees. */
function maxTurn(pts: readonly ScenePoint[]) {
  let worst = 0;
  for (let i = 2; i < pts.length; i++) {
    const ax = pts[i - 1].x - pts[i - 2].x, ay = pts[i - 1].y - pts[i - 2].y;
    const bx = pts[i].x - pts[i - 1].x, by = pts[i].y - pts[i - 1].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    worst = Math.max(worst, (Math.acos(c) * 180) / Math.PI);
  }
  return worst;
}

describe("live reshape only tidies near the pen", () => {
  for (const strength of [0.3, 0.6, 1.0]) {
    it(`leaves settled ink alone and adds no corner (strength ${strength})`, () => {
      seed = 3;
      const raw: ScenePoint[] = [];
      let x = 0, y = 0;
      let cache: LiveSmoothCache | null = null;
      let prev: ScenePoint[] | null = null;
      let frozen = 0;
      let drift = 0, windowed = 0, whole = 0, frames = 0;
      for (let n = 0; n < 700; n++) {
        x += 3 + rnd();
        y += Math.sin(n / 18) * 3 + (rnd() - 0.5);
        raw.push({ x, y, pressure: 0.6, slowness: 1.3 });
        if (raw.length < 20) continue;
        const r = smoothLiveInkPoints(raw, strength, nib, cache);
        cache = r.cache;
        if (prev && frozen > 0) {
          for (let i = 0; i < frozen; i++) {
            drift = Math.max(drift,
              Math.hypot(r.points[i].x - prev[i].x, r.points[i].y - prev[i].y));
          }
          frames++;
        }
        windowed = Math.max(windowed, maxTurn(r.points));
        whole = Math.max(whole, maxTurn(smoothInkPoints(raw, strength, nib, 0)));
        prev = r.points;
        frozen = cache ? cache.prefix.length : 0;
      }
      expect(frames).toBeGreaterThan(200);
      // Ink behind the pen must not move at all -- not merely move a little.
      expect(drift).toBe(0);
      // And splicing must not bend the path more than an unsplit pass would.
      expect(windowed).toBeLessThanOrEqual(whole + 5);
    });
  }

  it("falls back to a whole-buffer pass on a short stroke", () => {
    const raw: ScenePoint[] = [];
    for (let i = 0; i < 60; i++) raw.push({ x: i * 4, y: 0, pressure: 0.6, slowness: 1 });
    const r = smoothLiveInkPoints(raw, 0.6, nib, null);
    expect(r.cache).toBeNull();
    expect(r.points).toEqual(smoothInkPoints(raw, 0.6, nib, 0));
  });
});
