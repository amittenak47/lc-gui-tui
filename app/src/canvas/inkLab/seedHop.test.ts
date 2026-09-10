import { describe, expect, it } from "vitest";

import type { SpineDot } from "./instance";
import { seedSpineHop } from "./seedHop";

function dot(x: number, y: number, extra: Partial<SpineDot> = {}): SpineDot {
  return { x, y, r: 4, p: 0.5, ...extra };
}

describe("seedSpineHop", () => {
  it("keeps a collinear hop as a single to", () => {
    expect(seedSpineHop(dot(0, 0), dot(10, 0), dot(40, 0))).toEqual([dot(40, 0)]);
  });

  it("returns only to when there is no previous sample", () => {
    expect(seedSpineHop(null, dot(0, 0), dot(30, 10))).toEqual([dot(30, 10)]);
  });

  it("plants off-chord midpoints on a right-angle turn", () => {
    const to = dot(10, 10, { r: 8, p: 0.8 });
    const seeds = seedSpineHop(dot(0, 0), dot(10, 0, { r: 4, p: 0.2 }), to);
    expect(seeds[seeds.length - 1]).toBe(to);
    expect(seeds.length).toBeGreaterThan(1);
    let off = 0;
    for (const s of seeds.slice(0, -1)) {
      off = Math.max(off, Math.abs(s.x - 10));
    }
    expect(off).toBeGreaterThan(0.2);
    expect(seeds[0]!.r).toBeGreaterThan(4);
    expect(seeds[0]!.r).toBeLessThan(8);
  });
});
