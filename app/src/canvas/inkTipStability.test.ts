import { describe, it, expect } from "vitest";
import { trailingTipClusterStart, inkLineWidth, type ScenePoint } from "./rasterInk";

const nib = inkLineWidth(10, 0, false);

/**
 * How many times the tip mark swaps as the stroke is drawn, frame by frame.
 *
 * Peeling a tip cluster stamps a plain disc; not peeling draws a heading-
 * aligned cap. Every change of this predicate is a visible swap between the
 * two, so this count is the flicker.
 */
function flips(pts: ScenePoint[]) {
  let last: boolean | null = null;
  let n = 0;
  for (let i = 2; i <= pts.length; i++) {
    const slice = pts.slice(0, i);
    const has = trailingTipClusterStart(slice, nib) < slice.length;
    if (last !== null && has !== last) n++;
    last = has;
  }
  return n;
}

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

describe("tip stamp stability", () => {
  it("does not swap the tip mark during ordinary slow drawing", () => {
    // Spacings straddling the cluster threshold: where careful drawing lives.
    for (const step of [0.2, 0.3, 0.35, 0.5, 0.8]) {
      const pts: ScenePoint[] = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < 220; i++) {
        const d = nib * step * (0.7 + 0.6 * rnd());
        x += d * Math.cos(i / 40);
        y += d * Math.sin(i / 40);
        pts.push({ x, y, pressure: 0.6, slowness: 1.4 });
      }
      expect(flips(pts)).toBe(0);
    }
  });

  it("still recognises an actual stop", () => {
    const pts: ScenePoint[] = [];
    for (let i = 0; i < 40; i++) pts.push({ x: i * nib * 0.9, y: 0, pressure: 0.6, slowness: 1 });
    const tip = pts[pts.length - 1];
    for (let i = 0; i < 12; i++) {
      pts.push({ x: tip.x + (rnd() - 0.5) * 0.2, y: tip.y + (rnd() - 0.5) * 0.2,
        pressure: 0.6, slowness: 2 });
    }
    expect(trailingTipClusterStart(pts, nib)).toBeLessThan(pts.length);
  });
});
