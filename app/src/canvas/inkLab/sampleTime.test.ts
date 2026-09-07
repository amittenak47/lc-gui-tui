import { describe, expect, it } from "vitest";

import { stampLiveSamples } from "./sampleTime";

describe("stampLiveSamples", () => {
  it("keeps timestamps that already advance past the previous sample", () => {
    const out = stampLiveSamples(
      [
        { x: 0, y: 0, p: 0.5, t: 10 },
        { x: 8, y: 0, p: 0.5, t: 26 },
        { x: 16, y: 0, p: 0.5, t: 42 },
      ],
      0,
      50,
      0,
    );
    expect(out.map((s) => s.t)).toEqual([10, 26, 42]);
  });

  it("spreads a stuck coalesced batch over wall-clock time", () => {
    const out = stampLiveSamples(
      [
        { x: 0, y: 0, p: 0.5, t: 16 },
        { x: 12, y: 1, p: 0.5, t: 16 },
        { x: 24, y: 2, p: 0.5, t: 16 },
      ],
      16,
      32,
      16,
    );
    expect(out[0]!.t).toBeGreaterThan(16);
    expect(out[1]!.t).toBeGreaterThan(out[0]!.t);
    expect(out[2]!.t).toBeGreaterThan(out[1]!.t);
    expect(out[2]!.t - 16).toBeCloseTo(16, 5);
  });

  it("does not subtract wall clock from event timestamps", () => {
    const out = stampLiveSamples(
      [{ x: 8, y: 0, p: 0.5, t: 16 }],
      16,
      500_000,
      16,
    );
    expect(out[0]!.t).toBeLessThan(16 + 81);
    expect(out[0]!.t).toBeGreaterThan(16);
  });

  it("fills duplicate stamps inside an otherwise advancing batch", () => {
    const out = stampLiveSamples(
      [
        { x: 0, y: 0, p: 0.5, t: 20 },
        { x: 4, y: 0, p: 0.5, t: 20 },
        { x: 12, y: 0, p: 0.5, t: 36 },
      ],
      10,
      40,
      10,
    );
    expect(out[0]!.t).toBe(20);
    expect(out[1]!.t).toBe(21);
    expect(out[2]!.t).toBe(36);
  });
});
