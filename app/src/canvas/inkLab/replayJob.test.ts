import { describe, expect, it } from "vitest";

import { opsWithErasesBaked } from "../strokeEraser";
import type { InkOp } from "../rasterInk";
import { EraseBakeJob, replayUntil } from "./replayJob";

describe("replayUntil", () => {
  it("always paints one index even when the budget is already spent", () => {
    const painted: number[] = [];
    let calls = 0;
    const next = replayUntil(
      0,
      5,
      () => {
        calls += 1;
        return calls === 1 ? 0 : 100;
      },
      8,
      (i) => painted.push(i),
    );
    expect(painted).toEqual([0]);
    expect(next).toBe(1);
  });

  it("keeps painting while the clock stays inside the budget", () => {
    const painted: number[] = [];
    let t = 0;
    const next = replayUntil(
      0,
      5,
      () => {
        const now = t;
        t += 2;
        return now;
      },
      8,
      (i) => painted.push(i),
    );
    expect(painted).toEqual([0, 1, 2, 3]);
    expect(next).toBe(4);
  });

  it("is done when from is past the end", () => {
    expect(replayUntil(5, 5, () => 0, 8, () => {})).toBe(5);
  });
});

describe("EraseBakeJob", () => {
  it("matches the synchronous legacy erase bake across bounded steps", () => {
    const ops: InkOp[] = [
      {
        kind: "draw",
        color: "#111111",
        baseWidth: 2,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        points: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 20, y: 0, pressure: 0.5 },
        ],
      },
      {
        kind: "draw",
        color: "#111111",
        baseWidth: 2,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        points: [
          { x: 0, y: 20, pressure: 0.5 },
          { x: 20, y: 20, pressure: 0.5 },
        ],
      },
      { kind: "erase", radius: 3, points: [{ x: 10, y: 0, pressure: 0.5 }] },
    ];
    const job = new EraseBakeJob(ops);
    let clock = 0;
    let turns = 0;
    while (!job.step(() => clock++, 1)) turns += 1;
    expect(turns).toBeGreaterThan(1);
    expect(job.result()).toEqual(opsWithErasesBaked(ops));
  });
});
