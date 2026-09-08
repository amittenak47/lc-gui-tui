import { describe, expect, it } from "vitest";

import { replayUntil } from "./replayJob";

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
