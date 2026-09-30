import { describe, expect, it } from "vitest";

import {
  constrainCorner,
  cornerForDrag,
  curlGeometry,
  foldReflection,
  foldSide,
  sheetPart,
  turnCommits,
  turnProgress,
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

  it("goes over past 35% either way, and unravels short of it", () => {
    const at = (direction: "next" | "prev", dx: number) => cornerForDrag(direction, dx, 0, W, H, true).x;
    expect(turnProgress("next", at("next", -0.35 * W), W)).toBeCloseTo(0.35, 5);
    expect(turnCommits("next", at("next", -0.36 * W), W)).toBe(true);
    expect(turnCommits("next", at("next", -0.3 * W), W)).toBe(false);
    expect(turnCommits("prev", at("prev", 0.36 * W), W)).toBe(true);
    expect(turnCommits("prev", at("prev", 0.3 * W), W)).toBe(false);
  });

  it("lets a throw carry a short turn over, but not a twitch", () => {
    const corner = cornerForDrag("next", -0.2 * W, 0, W, H, true).x;
    expect(turnCommits("next", corner, W, 0.2 * W)).toBe(true);
    // A throw adds at most a quarter of the turn.
    const twitch = cornerForDrag("next", -0.05 * W, 0, W, H, true).x;
    expect(turnCommits("next", twitch, W, 5 * W)).toBe(false);
  });

  it("peels the held corner before the finger moves", () => {
    const held = cornerForDrag("next", 0, 0, W, H, true, 16);
    expect(held.x).toBeLessThan(W);
    expect(held.y).toBeLessThan(H);
    expect(curlGeometry(held, W, H, true).progress).toBeGreaterThan(0);
    expect(turnCommits("next", held.x, W)).toBe(false);
  });
});
