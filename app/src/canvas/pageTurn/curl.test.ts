import { describe, expect, it } from "vitest";

import {
  constrainCorner,
  cornerForCrease,
  cornerForGrip,
  curlGeometry,
  foldReflection,
  foldSide,
  sheetPart,
  turnCommits,
  turnTravel,
} from "./curl";

const W = 400;
const H = 600;

const apply = (m: number[], p: { x: number; y: number }) => ({
  x: m[0]! * p.x + m[2]! * p.y + m[4]!,
  y: m[1]! * p.x + m[3]! * p.y + m[5]!,
});

describe("page curl geometry", () => {
  it("is flat at rest and fully over when the corner reaches the far side", () => {
    expect(curlGeometry({ x: W, y: H }, W, H, true).progress).toBe(0);
    expect(curlGeometry({ x: -W, y: H }, W, H, true).progress).toBe(1);
  });

  it("keeps the corner within a sheet's width of the binding", () => {
    const p = constrainCorner({ x: -900, y: H }, W, H, true);
    expect(Math.hypot(p.x, p.y - H)).toBeCloseTo(W, 5);
  });

  it("reflects the corner's rest position onto the corner", () => {
    const g = curlGeometry({ x: 100, y: 520 }, W, H, true);
    const moved = apply(foldReflection(g), g.rest);
    expect(moved.x).toBeCloseTo(g.corner.x, 5);
    expect(moved.y).toBeCloseTo(g.corner.y, 5);
    // Points on the fold stay put.
    const onFold = apply(foldReflection(g), g.foldPoint);
    expect(onFold.x).toBeCloseTo(g.foldPoint.x, 5);
  });

  it("splits the sheet into a flat part and a flap that together cover it", () => {
    const g = curlGeometry({ x: 150, y: 560 }, W, H, true);
    const flap = sheetPart(g, W, H, true);
    const flat = sheetPart(g, W, H, false);
    expect(flap.length).toBeGreaterThanOrEqual(3);
    expect(flat.length).toBeGreaterThanOrEqual(3);
    // The binding side is never folded.
    expect(foldSide(g, { x: 0, y: 0 })).toBeLessThan(0);
    const area = (poly: { x: number; y: number }[]) =>
      Math.abs(poly.reduce((sum, p, i) => {
        const q = poly[(i + 1) % poly.length]!;
        return sum + p.x * q.y - q.x * p.y;
      }, 0)) / 2;
    expect(area(flap) + area(flat)).toBeCloseTo(W * H, 3);
  });

  it("goes over once the hand has carried it 35% across, and unravels short of it", () => {
    // Held by the corner: the corner is where the hand is.
    const held = (dx: number) => cornerForGrip({ x: W, y: H }, dx, 0, W, H, true).x;
    expect(turnTravel("next", held(-0.35 * W), W)).toBeCloseTo(0.35, 5);
    expect(turnCommits("next", held(-0.36 * W), W)).toBe(true);
    expect(turnCommits("next", held(-0.3 * W), W)).toBe(false);
    // Held by the crease, coming back: the crease is where the hand is.
    const crease = (x: number) => cornerForCrease(x, 0, W, H, true).x;
    expect(turnCommits("prev", crease(0.36 * W), W, 0, true)).toBe(true);
    expect(turnCommits("prev", crease(0.3 * W), W, 0, true)).toBe(false);
  });

  it("lets a throw carry a short turn over, but not a twitch", () => {
    const corner = cornerForGrip({ x: W, y: H }, -0.2 * W, 0, W, H, true).x;
    expect(turnCommits("next", corner, W, 0.2 * W)).toBe(true);
    // A throw adds at most a quarter of the page.
    const twitch = cornerForGrip({ x: W, y: H }, -0.05 * W, 0, W, H, true).x;
    expect(turnCommits("next", twitch, W, 5 * W)).toBe(false);
  });

  it("keeps a corner held by the finger under the finger", () => {
    const at = cornerForGrip({ x: 340, y: 560 }, -120, -40, W, H, true);
    expect(at).toEqual({ x: 220, y: 520 });
  });
});
