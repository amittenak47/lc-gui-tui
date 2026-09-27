import { describe, expect, it } from "vitest";

import {
  constrainCorner,
  cornerForDrag,
  curlGeometry,
  foldReflection,
  foldSide,
  sheetPart,
  turnCommits,
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

  it("turns at halfway either way", () => {
    expect(turnCommits("next", cornerForDrag("next", -W / 2 - 1, 0, W, H, true).x)).toBe(true);
    expect(turnCommits("next", cornerForDrag("next", -W / 2 + 20, 0, W, H, true).x)).toBe(false);
    expect(turnCommits("prev", cornerForDrag("prev", W / 2 + 1, 0, W, H, true).x)).toBe(true);
    expect(turnCommits("prev", cornerForDrag("prev", W / 2 - 20, 0, W, H, true).x)).toBe(false);
  });
});
